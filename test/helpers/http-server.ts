import http = require('http');
import https = require('https');
import net = require('net');
import express = require('express');
import pify = require('pify');
import pem = require('pem');
import bodyParser = require('body-parser');
import tempy = require('tempy');

export type BaseServerOptions = {
	protocol: 'HTTP' | 'HTTPS' | 'socket';
	installBodyParser?: boolean;
};
export type HttpServerOptions = BaseServerOptions & {
	protocol: 'HTTP';
};
export type HttpsServerOptions = BaseServerOptions & {
	protocol: 'HTTPS';
	commonName?: string;
	days?: number;
};
export type HttpSocketServerOptions = BaseServerOptions & {
	protocol: 'socket';
};
export type ServerOptions = HttpServerOptions | HttpsServerOptions | HttpSocketServerOptions;

export interface BaseExtendedServer extends express.Express {
	close: () => Promise<any>;
}
export interface ExtendedHttpServer extends BaseExtendedServer {
	protocol: 'HTTP';
	url: string;
	port: number;
	hostname: string;
	server: http.Server;
}
export interface ExtendedHttpsServer extends BaseExtendedServer {
	protocol: 'HTTPS';
	url: string;
	port: number;
	hostname: string;
	server: https.Server;
	caKey: Buffer;
	caCert: Buffer;
}
export interface ExtendedHttpSocketServer extends BaseExtendedServer {
	protocol: 'socket';
	server: http.Server;
	socketPath: string;
}
export type ExtendedServer = ExtendedHttpServer | ExtendedHttpsServer | ExtendedHttpSocketServer;

export interface CreateServerFunction {
	(options: HttpServerOptions): Promise<ExtendedHttpServer>;
	(options: HttpsServerOptions): Promise<ExtendedHttpsServer>;
	(options: HttpSocketServerOptions): Promise<ExtendedHttpSocketServer>;
}

export const createServer: CreateServerFunction = async <R extends ExtendedServer>(options: ServerOptions): Promise<R> => {
	const app = express() as R;
	app.protocol = options.protocol;

	app.set('etag', false);

	if (options.installBodyParser) {
		app.use(bodyParser.json({limit: '1mb', type: 'application/json'}));
		app.use(bodyParser.text({limit: '1mb', type: 'text/plain'}));
		app.use(bodyParser.urlencoded({limit: '1mb', type: 'application/x-www-form-urlencoded', extended: true}));
		app.use(bodyParser.raw({limit: '1mb', type: 'application/octet-stream'}));
	}

	if (options.protocol === 'HTTPS') {
		const certs = await makeCerts(options);
		const server = https.createServer({
			key: certs.key,
			cert: certs.cert,
			ca: certs.caCert,
			requestCert: true,
			rejectUnauthorized: false // Certificate validity should checked by the test
		}, app);
		(app as ExtendedHttpsServer).caKey = certs.caKey;
		(app as ExtendedHttpsServer).caCert = certs.caCert;

		await pify(server.listen.bind(server))();

		(app as ExtendedHttpsServer).port = (server.address() as net.AddressInfo).port;
		(app as ExtendedHttpsServer).url = `https://localhost:${(app as ExtendedHttpsServer).port}`;
		(app as ExtendedHttpsServer).hostname = 'localhost';

		app.server = server;
		app.close = async () => pify(server.close.bind(app.server));
	} else if (options.protocol === 'socket') {
		const socketPath = tempy.file({extension: 'socket'});

		const server = http.createServer((request, response) => {
			server.emit(request.url!, request, response);
		});

		await pify(server.listen.bind(server))(socketPath);

		(app as ExtendedHttpSocketServer).socketPath = socketPath;

		app.server = server;
		app.close = async () => pify(server.close.bind(app.server));
	} else {
		const server = http.createServer(app);

		await pify(server.listen.bind(server))();

		(app as ExtendedHttpServer).port = (server.address() as net.AddressInfo).port;
		(app as ExtendedHttpServer).url = `http://localhost:${(app as ExtendedHttpsServer).port}`;
		(app as ExtendedHttpServer).hostname = 'localhost';

		app.server = server;
		app.close = async () => pify(server.close.bind(app.server));
	}

	return app;
};

// TODO: this should be removed (not used by Got)
// export const createHttpServer = async (options?: HttpServerOptions) => createServer({protocol: 'HTTP', ...options});
// export const createHttpsServer = async (options?: HttpsServerOptions) => createServer({protocol: 'HTTPS', ...options});

// Boring logic ahead, you've been warned

// TODO `options` should be a subset of `HttpsServerOptions`
const makeCerts = async (options: HttpsServerOptions) => {
	const createCSR = pify(pem.createCSR);
	const createCertificate = pify(pem.createCertificate);

	const caCSRResult = await createCSR({commonName: 'authority'});
	const caResult = await createCertificate({
		csr: caCSRResult.csr,
		clientKey: caCSRResult.clientKey,
		selfSigned: true
	});
	const caKey = caResult.clientKey;
	const caCert = caResult.certificate;

	const serverCSRResult = await createCSR({commonName: options.commonName ?? 'localhost'});
	const serverResult = await createCertificate({
		csr: serverCSRResult.csr,
		clientKey: serverCSRResult.clientKey,
		serviceKey: caKey,
		serviceCertificate: caCert,
		days: options.days ?? 365
	});
	const serverKey = serverResult.clientKey;
	const serverCert = serverResult.certificate;

	return {
		key: serverKey,
		cert: serverCert,
		caCert,
		caKey
	};
};
