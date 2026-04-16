import net from 'node:net';
import {promisify} from 'node:util';
import getStream from 'get-stream';
import createHttpTestServer from './create-http-test-server.js';

export const createRawHttpServer = async (onConnection?: (socket: net.Socket) => void): Promise<{
	server: net.Server;
	port: number;
	close: () => Promise<void>;
}> => {
	const server = net.createServer(socket => {
		onConnection?.(socket);
	});

	const listen = promisify(server.listen.bind(server) as (callback: (error?: Error) => void) => void);
	const close = promisify(server.close.bind(server) as (callback: (error?: Error) => void) => void);

	await listen();

	return {
		server,
		port: (server.address() as net.AddressInfo).port,
		close,
	};
};

export const createCrossOriginReceiver = async (path = '/steal', responseBody = JSON.stringify({result: 'ok'})) => {
	const server = await createHttpTestServer({bodyParser: false});
	const received = {
		authorization: undefined as string | undefined,
		cookie: undefined as string | undefined,
		body: '',
		contentType: undefined as string | undefined,
	};

	server.post(path, async (request, response) => {
		received.authorization = request.headers.authorization;
		received.cookie = request.headers.cookie;
		received.body = await getStream(request);
		received.contentType = request.headers['content-type'];
		response.end(responseBody);
	});

	server.get(path, (request, response) => {
		received.authorization = request.headers.authorization;
		received.cookie = request.headers.cookie;
		received.contentType = request.headers['content-type'];
		response.end(responseBody);
	});

	return {server, received};
};

export const createRetryUrlServer = async (retryUrl: string, responsePath = '/api') => {
	const server = await createHttpTestServer();
	const respond = (_request: unknown, response: {setHeader: (name: string, value: string) => void; end: (value: string) => void}) => {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({retryUrl}));
	};

	server.get(responsePath, respond);
	server.post(responsePath, respond);

	return server;
};
