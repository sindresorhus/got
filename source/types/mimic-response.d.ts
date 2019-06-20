declare module 'mimic-response' {
	import {IncomingMessage} from 'http';
	import {Transform as TransformStream} from 'stream';

	declare function mimicResponse(input: IncomingMessage, output: TransformStream): void;

	export = mimicResponse;
}
