import http = require('http');
import https = require('https');
import net = require('net');
import express = require('express');
import pify = require('pify');
import pem = require('pem');
import bodyParser = require('body-parser');

export type BaseServerOptions = {
	protocol: 'HTTP' | 'HTTPS';
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
export type ServerOptions = HttpServerOptions | HttpsServerOptions;

export interface BaseExtendedServer extends express.Express {
	url: string;
	port: number;
	hostname: string;
	close: () => Promise<any>;
}
export interface ExtendedHttpServer extends BaseExtendedServer {
	protocol: 'HTTP';
	server: http.Server;
}
export interface ExtendedHttpsServer extends BaseExtendedServer {
	protocol: 'HTTPS';
	server: https.Server;
	caKey: Buffer;
	caCert: Buffer;
}
export type ExtendedServer = ExtendedHttpServer | ExtendedHttpsServer;

export interface CreateServerFunction {
	(options: HttpServerOptions): Promise<ExtendedHttpServer>;
	(options: HttpsServerOptions): Promise<ExtendedHttpsServer>;
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

	let server;
	if (options.protocol === 'HTTPS') {
		const certs = await makeCerts(options);
		server = https.createServer({
			key: certs.key,
			cert: certs.cert,
			ca: certs.caCert,
			requestCert: true,
			rejectUnauthorized: false // Certificate validity should checked by the test
		}, app);
		(app as ExtendedHttpsServer).caKey = certs.caKey;
		(app as ExtendedHttpsServer).caCert = certs.caCert;
	} else {
		server = http.createServer(app);
	}

	app.server = server;

	await pify(app.server.listen.bind(app.server))();

	app.port = (app.server.address() as net.AddressInfo).port;

	if (options.protocol === 'HTTPS') {
		app.url = `https://localhost:${(app.port)}`;
	} else {
		app.url = `http://localhost:${(app.port)}`;
	}

	app.hostname = 'localhost';

	// TODO: Check if this is correct
	app.close = (): any => pify(app.server.close.bind(app.server));

	return app;
};

// TODO: this should be removed (not used by Got)
export const createHttpServer = async (options?: HttpServerOptions) => createServer({protocol: 'HTTP', ...options});
export const createHttpsServer = async (options?: HttpsServerOptions) => createServer({protocol: 'HTTPS', ...options});

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
