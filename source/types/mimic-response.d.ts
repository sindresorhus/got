declare module 'mimic-response' {
	import {IncomingMessage} from 'http';
	import {Transform as TransformStream} from 'stream';

	export default function(input: IncomingMessage, output: TransformStream): void;
}
