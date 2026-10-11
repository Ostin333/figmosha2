const root = args.root ? await h.resolve(args.root) : figma.currentPage;
if (!root) throw new Error("no node " + args.root);
return h.lint(root, args);
