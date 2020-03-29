import FormData = require('form-data');
import is from '@sindresorhus/is';

export default (body: unknown): body is FormData => is.nodeStream(body) && is.function_((body as FormData).getBoundary);
