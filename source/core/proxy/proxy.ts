import type {URL} from 'url';
import {auto} from 'http2-wrapper';
import type {Agents} from '../options';

import {
	HttpsProxyAgent,
	HttpRegularProxyAgent,
	HttpOverHttp2,
	HttpsOverHttp2,
	Http2OverHttp2,
	Http2OverHttps,
	Http2OverHttp,
} from './agents.js';

export async function getProxyAgents(parsedProxyUrl: URL, rejectUnauthorized: boolean) {
	// Sockets must not be reused, the proxy server may rotate upstream proxies as well.

	// `http2-wrapper` Agent options
	const wrapperOptions = {
		proxyOptions: {
			url: parsedProxyUrl,

			// Based on the got https.rejectUnauthorized option
			rejectUnauthorized,
		},

		// The sockets won't be reused, no need to keep them
		maxFreeSockets: 0,
		maxEmptySessions: 0,
	};

	// Native `http.Agent` options
	const nativeOptions = {
		proxy: parsedProxyUrl,

		// The sockets won't be reused, no need to keep them
		maxFreeSockets: 0,
	};

	let agent: Agents;

	if (parsedProxyUrl.protocol === 'https:') {
		let alpnProtocol = 'http/1.1';

		try {
			const result = await auto.resolveProtocol({
				host: parsedProxyUrl.hostname,
				port: parsedProxyUrl.port,
				rejectUnauthorized,
				ALPNProtocols: ['h2', 'http/1.1'],
				servername: parsedProxyUrl.hostname,
			});

			alpnProtocol = result.alpnProtocol;
		} catch {
			// Some proxies don't support CONNECT protocol, use http/1.1
		}

		const proxyIsHttp2 = alpnProtocol === 'h2';

		if (proxyIsHttp2) {
			agent = {
				http: new HttpOverHttp2(wrapperOptions),
				https: new HttpsOverHttp2(wrapperOptions),
				http2: new Http2OverHttp2(wrapperOptions),
			};
		} else {
			// Upstream proxies hang up connections on CONNECT + unsecure HTTP
			agent = {
				http: new HttpRegularProxyAgent(nativeOptions),
				https: new HttpsProxyAgent(nativeOptions),
				http2: new Http2OverHttps(wrapperOptions),
			};
		}
	} else {
		// Upstream proxies hang up connections on CONNECT + unsecure HTTP
		agent = {
			http: new HttpRegularProxyAgent(nativeOptions),
			https: new HttpsProxyAgent(nativeOptions),
			http2: new Http2OverHttp(wrapperOptions),
		};
	}

	return agent;
}
