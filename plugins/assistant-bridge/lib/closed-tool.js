import { ToolArgsError } from '@deepseek-ai/dsh-tools';
/** Closes the implicit open root of Harness parameter schemas and enforces it again at runtime. */
export function closedTool(tool, allowedKeys) {
    const allowed = new Set(allowedKeys);
    return {
        ...tool,
        parameters: { ...tool.parameters, additionalProperties: false },
        async execute(args, exec) {
            if (typeof args !== 'object' || args === null || Array.isArray(args)) {
                throw new ToolArgsError(['/: arguments must be an object']);
            }
            const unexpected = Object.keys(args).filter(key => !allowed.has(key));
            if (unexpected.length > 0)
                throw new ToolArgsError(unexpected.map(key => `/${key}: additional property is not allowed`));
            return tool.execute(args, exec);
        },
    };
}
