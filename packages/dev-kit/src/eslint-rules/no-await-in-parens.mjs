/** @type {import('eslint').Rule.RuleModule} */
export const noAwaitInParens = {
	meta: {
		type: 'suggestion',
		messages: {
			noAwaitInParens: 'Do not wrap await expressions in parentheses. Use an intermediate variable instead.'
		}
	},
	create(context) {
		return {
			AwaitExpression(node) {
				const sourceCode = context.sourceCode;
				const tokenBefore = sourceCode.getTokenBefore(node, { includeComments: false });
				const tokenAfter = sourceCode.getTokenAfter(node, { includeComments: false });

				if (tokenBefore && tokenBefore.value === '(' && tokenAfter && tokenAfter.value === ')') {
					context.report({
						node,
						messageId: 'noAwaitInParens'
					});
				}
			}
		};
	}
};
