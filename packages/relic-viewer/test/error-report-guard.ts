import * as ts from 'typescript';

// The reporter has no reason to reference any of these page-state names.
// Ban them even as aliases or property names, not just as window.foo reads.
const FORBIDDEN: Readonly<Record<string, true>> = {
  location: true,
  history: true,
  document: true,
  cookie: true,
  referrer: true,
  title: true,
  localStorage: true,
  sessionStorage: true,
  indexedDB: true,
  hash: true,
  fragment: true,
  name: true,
  eval: true,
  Function: true,
};

/** Return source references to private page state or dynamically chosen keys. */
export function reporterPageStateReferences(root: ts.Node): string[] {
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && Object.hasOwn(FORBIDDEN, node.text))
      findings.push(node.text);
    if (ts.isStringLiteralLike(node) && Object.hasOwn(FORBIDDEN, node.text)) {
      const parent = node.parent;
      if (
        ts.isElementAccessExpression(parent) ||
        ts.isCallExpression(parent) ||
        ts.isBindingElement(parent) ||
        ts.isPropertyAssignment(parent)
      )
        findings.push(node.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      if (
        argument &&
        !ts.isStringLiteralLike(argument) &&
        !ts.isNumericLiteral(argument)
      )
        findings.push('dynamic property');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Reflect' &&
      node.expression.name.text === 'get' &&
      (!node.arguments[1] || !ts.isStringLiteralLike(node.arguments[1]))
    )
      findings.push('dynamic Reflect.get');
    ts.forEachChild(node, visit);
  };
  visit(root);
  return findings;
}
