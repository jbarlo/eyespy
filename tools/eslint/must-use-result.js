/**
 * eyespy/must-use-result reports a dropped neverthrow Result. An expression statement whose value is a Result, or
 * `void result`, swallows an error. Needs type information.
 */
import { ESLintUtils } from "@typescript-eslint/utils";

const RESULT_TYPES = new Set(["Ok", "Err", "ResultAsync"]);

/** @param {import("typescript").Type} type */
function isResult(type) {
  if (type.isUnion()) return type.types.some(isResult);
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol || !RESULT_TYPES.has(symbol.getName())) return false;
  return (symbol.getDeclarations() ?? []).some((d) => /[\\/]neverthrow[\\/]/.test(d.getSourceFile().fileName));
}

export default ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: "problem",
    messages: {
      dropped: "This Result is dropped: handle it (match / isErr / unwrapOr) or return it.",
      voided: "Don't discard a Result with void: handle it (match / isErr / unwrapOr) or return it.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    /** @param {import("@typescript-eslint/utils").TSESTree.Node} node */
    const resultLike = (node) => {
      const type = services.getTypeAtLocation(node);
      return isResult(type) || isResult(checker.getAwaitedType(type) ?? type);
    };
    return {
      ExpressionStatement(node) {
        const e = node.expression;
        if (e.type === "UnaryExpression" && e.operator === "void") {
          if (resultLike(e.argument)) context.report({ node, messageId: "voided" });
        } else if (resultLike(e)) {
          context.report({ node, messageId: "dropped" });
        }
      },
    };
  },
});
