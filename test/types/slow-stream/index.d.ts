import {PassThrough} from 'node:stream';

declare module 'slow-stream' {
	export = PassThrough;
}
