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
	socket: number | null;
	lookup: number | null;
	connect: number | null;
	upload: number | null;
	response: number | null;
	end: number | null;
	error: number | null;
	phases: {
		wait: number | null;
		dns: number | null;
		tcp: number | null;
		request: number | null;
		firstByte: number | null;
		download: number | null;
		total: number | null;
	};
}
