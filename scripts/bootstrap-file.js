const pages = args.pages || ["Cover", "Tokens", "Components", "Screens"];
const report = { pages: { created: [], existing: [] } };
const first = figma.root.children[0];
pages.forEach((name, i) => {
  let page = figma.root.children.find((p) => p.name === name);
  if (page) { report.pages.existing.push(name); return; }
  if (i === 0 && figma.root.children.length === 1 && /^Page 1$/.test(first.name) && first.children.length === 0) {
    first.name = name;
  } else {
    page = figma.createPage();
    page.name = name;
  }
  report.pages.created.push(name);
});
if (args.tokens) report.tokens = await h.tokens(args.tokens);
if (args.textStyles) report.textStyles = await h.textStyles(args.textStyles);
if (args.effectStyles) report.effectStyles = await h.effectStyles(args.effectStyles);
return report;
