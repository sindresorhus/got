import {IncomingMessage} from 'http';
import {RequestOptions} from 'https';

export interface Options extends RequestOptions {
	host: string;
	hostname: string;
	method: string;
	path: string;
	socketPath: string;
	protocol: string;
	href: string;
	options: Options;
}

export interface Response extends IncomingMessage {
	body: string | Buffer;
	statusCode: number;
}

export interface Timings {
	start: number;
	socket: number;
	lookup: number;
	connect: number;
	upload: number;
	response: number;
	end: number;
	error: number;
	phases: {
		wait: number;
		dns: number;
		tcp: number;
		request: number;
		firstByte: number;
		download: number;
		total: number;
	};
}
