const set = await h.resolve(args.set);
if (!set) throw new Error("no node " + args.set);
return h.arrange(set, args);
