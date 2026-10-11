import pytest

import bridge
from test_bridge import FakePlugin, make_client, run


def exec_messages(plugin):
    return [m for m in plugin.received if m.get("type") == "exec"]


def test_args_and_checkpoint_travel_with_the_script():
    async def go():
        c = await make_client()
        async with FakePlugin(c) as p:
            r = await c.post("/exec", json={"code": "return args.n", "args": {"n": [1, "два"]},
                                            "checkpoint": " before tokens "})
            assert r.status == 200
            m = exec_messages(p)[0]
            assert m["args"] == {"n": [1, "два"]}
            assert m["checkpoint"] == "before tokens"
            await c.post("/exec", json={"code": "x"})
            assert "args" not in exec_messages(p)[1] and "checkpoint" not in exec_messages(p)[1]
        await c.close()
    run(go())


@pytest.mark.parametrize("body", [
    {"checkpoint": ""}, {"checkpoint": "   "}, {"checkpoint": 5}, {"checkpoint": "x" * 81},
    {"max_result": -1}, {"max_result": "8k"}, {"max_result": True}, {"max_result": 1.5},
])
def test_bad_options_are_400_and_run_nothing(body):
    async def go():
        c = await make_client()
        async with FakePlugin(c) as p:
            r = await c.post("/exec", json={"code": "x", **body})
            assert r.status == 400
            assert p.seen_codes == []
        await c.close()
    run(go())


def test_mutated_and_checkpoint_are_reported():
    async def go():
        c = await make_client()
        replies = iter([
            {"value": 1, "mutated": True, "checkpoint": {"id": "v1", "title": "figmosha: x"}},
            {"type": "error", "text": "boom", "mutated": False},
        ])
        async with FakePlugin(c, reply=lambda code: next(replies)):
            body = await (await c.post("/exec", json={"code": "a"})).json()
            assert body["mutated"] is True and body["checkpoint"]["id"] == "v1"
            r = await c.post("/exec", json={"code": "b"})
            assert r.status == 500 and (await r.json())["mutated"] is False
        await c.close()
    run(go())


def test_long_list_results_are_cut_to_whole_items():
    async def go():
        c = await make_client()
        items = [{"id": f"1:{i}", "name": "Frame " * 5} for i in range(500)]
        async with FakePlugin(c, reply=lambda code: {"value": items}):
            body = await (await c.post("/exec", json={"code": "a", "max_result": 2000})).json()
            t = body["truncated"]
            assert t["unit"] == "items" and t["total"] == 500 and 0 < t["shown"] < 500
            assert body["value"] == items[:t["shown"]]
            assert len(body["result"].encode()) <= 2000
            full = await (await c.post("/exec", json={"code": "a"})).json()
            assert "truncated" not in full and len(full["value"]) == 500
        await c.close()
    run(go())


def test_long_text_results_are_cut_on_a_character_boundary():
    async def go():
        c = await make_client()
        async with FakePlugin(c, reply=lambda code: {"value": "ї" * 5000}):
            body = await (await c.post("/exec", json={"code": "a", "max_result": 1001})).json()
            assert body["result"] == "ї" * 500
            assert body["truncated"] == {"shown": 500, "total": 5000, "unit": "chars",
                                         "hint": body["truncated"]["hint"]}
        await c.close()
    run(go())


def test_small_results_are_untouched():
    async def go():
        c = await make_client()
        async with FakePlugin(c, reply=lambda code: {"value": {"a": 1}}):
            body = await (await c.post("/exec", json={"code": "a", "max_result": 8000})).json()
            assert body["value"] == {"a": 1} and "truncated" not in body
        await c.close()
    run(go())


def test_root_lists_the_new_options():
    async def go():
        c = await make_client()
        text = (await (await c.get("/")).json())["endpoints"]["POST /exec"]
        for word in ("args", "checkpoint", "max_result", "mutated", "Bearer"):
            assert word in text
        await c.close()
    run(go())


def test_a_list_that_fits_compactly_is_not_marked_truncated():
    async def go():
        c = await make_client()
        items = [{"id": f"1:{i}", "n": i} for i in range(40)]
        async with FakePlugin(c, reply=lambda code: {"value": items}):
            body = await (await c.post("/exec", json={"code": "a", "max_result": 1200})).json()
            assert "truncated" not in body and body["value"] == items
        await c.close()
    run(go())
