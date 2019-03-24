import is from '@sindresorhus/is';
import FormData from 'form-data';

export default (body: unknown): body is FormData => is.nodeStream(body) && is.function_((body as FormData).getBoundary);
