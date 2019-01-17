import is from '@sindresorhus/is';

export default (body: unknown): boolean => is.nodeStream(body) && is.function_((body as any).getBoundary);
