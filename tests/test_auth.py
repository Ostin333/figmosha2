import asyncio
import hmac
import json
import os
import stat

import aiohttp
import pytest

import bridge
from test_bridge import FakePlugin, make_client, run
from test_queue import SlowPlugin

SECRET = "s3cret-token-for-tests"
AUTH = {"Authorization": f"Bearer {SECRET}"}


class TokenPlugin(FakePlugin):
    def __init__(self, client, token=SECRET, **kw):
        super().__init__(client, **kw)
        self.token = token

    async def __aenter__(self):
        self.ws = await self.client.ws_connect("/plugin", headers={"Origin": "null"})
        hello = {"type": "hello", "version": "test", "name": "Auth file", "docSig": "dauth0001"}
        if self.token is not None:
            hello["token"] = self.token
        await self.ws.send_str(json.dumps(hello))
        self._task = asyncio.create_task(self._pump())
        await asyncio.sleep(0.1)
        return self


class SlowTokenPlugin(TokenPlugin, SlowPlugin):
    pass


def with_token(require=False):
    bridge.TOKEN = SECRET
    bridge.REQUIRE_TOKEN = require


async def closed_with(ws, timeout=2.0):
    async def drain():
        async for _ in ws:
            pass
    await asyncio.wait_for(drain(), timeout)
    return ws.close_code


def test_http_without_token_works_in_soft_mode_but_says_so():
    async def go():
        with_token()
        c = await make_client()
        async with TokenPlugin(c):
            r = await c.post("/exec", json={"code": "return 1"})
            assert r.status == 200
            assert "token" in (await r.json())["notice"]
            r = await c.get("/status")
            assert (await r.json())["auth"] == {"token": True, "required": False, "caller": "missing"}
        await c.close()
    run(go())


def test_http_with_the_right_token_has_no_notice():
    async def go():
        with_token(require=True)
        c = await make_client()
        async with TokenPlugin(c):
            r = await c.post("/exec", json={"code": "return 1"}, headers=AUTH)
            assert r.status == 200
            assert "token" not in (await r.json()).get("notice", "")
            r = await c.get("/status", headers=AUTH)
            assert (await r.json())["auth"]["caller"] == "ok"
        await c.close()
    run(go())


@pytest.mark.parametrize("header", [
    "Bearer wrong", "Bearer ", "bearer s3cret-token-for-test", "Basic " + SECRET,
    SECRET, "Bearer " + SECRET + "x", "Bearer " + SECRET.upper(), "Bearer абв",
])
def test_http_with_a_bad_token_is_401_even_in_soft_mode(header):
    async def go():
        with_token()
        c = await make_client()
        async with TokenPlugin(c) as p:
            for method, path in (("POST", "/exec"), ("GET", "/status"), ("GET", "/targets"),
                                 ("POST", "/clear")):
                r = await c.request(method, path, json={"code": "return 1"},
                                    headers={"Authorization": header})
                assert r.status == 401, (path, header)
            assert p.seen_codes == []
        await c.close()
    run(go())


def test_required_token_refuses_http_without_it():
    async def go():
        with_token(require=True)
        c = await make_client()
        async with TokenPlugin(c) as p:
            r = await c.post("/exec", json={"code": "return 1"})
            assert r.status == 401
            assert "missing" in (await r.json())["error"]
            assert p.seen_codes == []
            r = await c.get("/")
            assert r.status == 200
        await c.close()
    run(go())


def test_compare_digest_is_used(monkeypatch):
    calls = []
    real = hmac.compare_digest

    def spy(a, b):
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr(bridge.hmac, "compare_digest", spy)
    with_token()
    assert bridge.token_ok(SECRET) and not bridge.token_ok("nope")
    assert len(calls) == 2


def test_rogue_page_without_token_never_receives_exec():
    async def go():
        with_token(require=True)
        c = await make_client()
        async with TokenPlugin(c, token=None) as rogue:
            assert await closed_with(rogue.ws) == bridge.AUTH_CLOSE
            r = await c.post("/exec", json={"code": "return secrets"}, headers=AUTH)
            assert r.status == 503
            assert rogue.seen_codes == []
            assert {"type": "auth", "state": "missing"} in rogue.received
        await c.close()
    run(go())


def test_wrong_plugin_token_is_closed_even_in_soft_mode():
    async def go():
        with_token()
        c = await make_client()
        async with TokenPlugin(c, token="guess") as rogue:
            assert await closed_with(rogue.ws) == bridge.AUTH_CLOSE
            r = await c.post("/exec", json={"code": "return 1"})
            assert r.status == 503
            assert rogue.seen_codes == []
        await c.close()
    run(go())


def test_plugin_without_token_is_refused_even_in_soft_mode():
    async def go():
        with_token()
        c = await make_client()
        async with TokenPlugin(c, token=None) as p:
            assert await closed_with(p.ws) == bridge.AUTH_CLOSE
            assert {"type": "auth", "state": "missing"} in p.received
            r = await c.post("/exec", json={"code": "return 1"})
            assert r.status == 503
            assert p.seen_codes == []
        await c.close()
    run(go())


def test_silent_connections_are_closed_in_soft_mode_too(monkeypatch):
    async def go():
        monkeypatch.setattr(bridge, "HELLO_GRACE", 0.2)
        with_token()
        c = await make_client()
        ws = await c.ws_connect("/plugin", headers={"Origin": "null"})
        assert await closed_with(ws) == bridge.AUTH_CLOSE
        await c.close()
    run(go())


def test_unauthenticated_sockets_cannot_crowd_out_the_plugin(monkeypatch):
    async def go():
        monkeypatch.setattr(bridge, "MAX_UNADMITTED", 2)
        with_token()
        c = await make_client()
        squatters = [await c.ws_connect("/plugin", headers={"Origin": "null"}) for _ in range(2)]
        await asyncio.sleep(0.05)
        extra = await c.ws_connect("/plugin", headers={"Origin": "null"})
        assert await closed_with(extra) == bridge.LIMIT_CLOSE
        for ws in squatters:
            await ws.close()
        await asyncio.sleep(0.05)
        async with TokenPlugin(c):
            r = await c.post("/exec", json={"code": "return 1"}, headers=AUTH)
            assert r.status == 200
        await c.close()
    run(go())


def test_empty_token_file_is_replaced(tmp_path, monkeypatch):
    monkeypatch.delenv("FIGMOSHA_TOKEN", raising=False)
    monkeypatch.setenv("FIGMOSHA_HOME", str(tmp_path))
    (tmp_path / "token").write_text("\n")
    token = bridge.load_token()
    assert len(token) >= 40
    assert (tmp_path / "token").read_text().strip() == token
    assert stat.S_IMODE(os.stat(tmp_path / "token").st_mode) == 0o600


def test_authenticated_plugin_works_and_is_marked():
    async def go():
        with_token(require=True)
        c = await make_client()
        async with TokenPlugin(c) as p:
            r = await c.post("/exec", json={"code": "return 1"}, headers=AUTH)
            assert r.status == 200
            assert {"type": "auth", "state": "ok"} in p.received
            files = (await (await c.get("/targets", headers=AUTH)).json())["files"]
            assert files[0]["authed"] is True
        await c.close()
    run(go())


def test_connection_without_hello_is_closed_after_the_grace_period(monkeypatch):
    async def go():
        monkeypatch.setattr(bridge, "HELLO_GRACE", 0.2)
        with_token(require=True)
        c = await make_client()
        ws = await c.ws_connect("/plugin", headers={"Origin": "null"})
        assert await closed_with(ws) == bridge.AUTH_CLOSE
        assert bridge.PLUGINS == {}
        await c.close()
    run(go())


def test_unadmitted_connection_cannot_answer_for_someone_else():
    async def go():
        with_token(require=True)
        c = await make_client()
        async with SlowTokenPlugin(c, delay=0.4):
            task = asyncio.create_task(c.post("/exec", json={"code": "x", "timeout": 5},
                                              headers=AUTH))
            await asyncio.sleep(0.1)
            rid = next(iter(bridge.PENDING))
            intruder = await c.ws_connect("/plugin", headers={"Origin": "null"})
            await intruder.send_str(json.dumps({"type": "result", "id": rid, "value": "forged"}))
            r = await task
            assert (await r.json())["value"] is None
            assert (await r.json())["result"] == "x"
            await intruder.close()
        await c.close()
    run(go())


def test_too_many_plugin_connections_are_refused(monkeypatch):
    async def go():
        monkeypatch.setattr(bridge, "MAX_PLUGINS", 2)
        c = await make_client()
        async with FakePlugin(c), FakePlugin(c):
            ws = await c.ws_connect("/plugin", headers={"Origin": "null"})
            assert await closed_with(ws) == bridge.LIMIT_CLOSE
        await c.close()
    run(go())


def test_hello_flood_is_cut_off(monkeypatch):
    async def go():
        monkeypatch.setattr(bridge, "HELLO_RATE", 3)
        c = await make_client()
        ws = await c.ws_connect("/plugin", headers={"Origin": "null"})
        for i in range(6):
            await ws.send_str(json.dumps({"type": "hello", "name": f"n{i}"}))
        assert await closed_with(ws) == bridge.LIMIT_CLOSE
        await c.close()
    run(go())


def test_full_queue_is_503_and_runs_nothing(monkeypatch):
    async def go():
        monkeypatch.setattr(bridge, "MAX_WAITING", 1)
        c = await make_client()
        async with SlowPlugin(c, 0.4) as p:
            first = asyncio.create_task(c.post("/exec", json={"code": "a", "timeout": 5}))
            await asyncio.sleep(0.05)
            second = asyncio.create_task(c.post("/exec", json={"code": "b", "timeout": 5}))
            await asyncio.sleep(0.05)
            r = await c.post("/exec", json={"code": "c", "timeout": 5})
            assert r.status == 503
            assert "queue full" in (await r.json())["error"]
            assert [(await t).status for t in (first, second)] == [200, 200]
            assert p.seen_codes == ["a", "b"]
        await c.close()
    run(go())


def test_timeouts_are_capped_unless_long_runs_are_allowed():
    async def go():
        c = await make_client()
        async with FakePlugin(c):
            r = await c.post("/exec", json={"code": "x", "timeout": 601})
            assert r.status == 400
            bridge.MAX_SECONDS = bridge.LONG_MAX_SECONDS
            r = await c.post("/exec", json={"code": "x", "timeout": 601})
            assert r.status == 200
        await c.close()
    run(go())


def test_interlock_message_no_longer_suggests_force():
    async def go():
        c = await make_client()
        async with FakePlugin(c):
            bridge.ABANDONED["r" * 36] = {"conn": next(iter(bridge.PLUGINS)),
                                          "doc": bridge._doc_key(next(iter(bridge.PLUGINS))),
                                          "t0": 0, "timeout": 1}
            r = await c.post("/exec", json={"code": "x"})
            assert r.status == 409
            assert "force" not in (await r.json())["error"]
        await c.close()
    run(go())


def test_token_file_is_created_private_and_reused(tmp_path, monkeypatch):
    monkeypatch.delenv("FIGMOSHA_TOKEN", raising=False)
    monkeypatch.setenv("FIGMOSHA_HOME", str(tmp_path / "home"))
    first = bridge.load_token()
    path = tmp_path / "home" / "token"
    assert len(first) >= 40
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(path.parent).st_mode) == 0o700
    assert bridge.load_token() == first


def test_env_token_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("FIGMOSHA_HOME", str(tmp_path))
    monkeypatch.setenv("FIGMOSHA_TOKEN", "from-env")
    assert bridge.load_token() == "from-env"
    assert not (tmp_path / "token").exists()
