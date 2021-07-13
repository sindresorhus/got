import got from '../../dist/source/index.js';

/*
* Got supports composing multiple instances together. This is very powerful.
*
* You can create a client that limits download speed,
* 	then compose it with an instance that signs a request.
*
* It's like plugins without any of the plugin mess.
* You just create instances and then compose them together.
*
* To mix them use `instanceA.extend(instanceB, instanceC, ...)`, that's all.
* Let's begin.
*/

// Logging all `got(…)` calls
const logger = got.extend({
	handlers: [
		(options, next) => {
			console.log(`Sending ${options.method} to ${options.url}`);
			return next(options);
		}
	]
});

// Denying redirects to foreign hosts
const controlRedirects = got.extend({
	hooks: {
		beforeRedirect: [
			(options, response) => {
				const {origin} = response.request.options.url;
				if (options.url.origin !== origin) {
					throw new Error(`Redirection to ${options.url.origin} is not allowed from ${origin}`);
				}
			}
		]
	}
});

// Limiting download & upload size
// This can prevent crashing due to insufficient memory
const limitDownloadUpload = got.extend({
	handlers: [
		(options, next) => {
			const {downloadLimit, uploadLimit} = options.context;
			let promiseOrStream = next(options);

			// A destroy function that supports both promises and streams
			const destroy = message => {
				if (options.isStream) {
					promiseOrStream.destroy(new Error(message));
					return;
				}

				promiseOrStream.cancel(message);
			};

			if (typeof downloadLimit === 'number') {
				promiseOrStream.on('downloadProgress', progress => {
					if (progress.transferred > downloadLimit && progress.percent !== 1) {
						destroy(`Exceeded the download limit of ${downloadLimit} bytes`);
					}
				});
			}

			if (typeof uploadLimit === 'number') {
				promiseOrStream.on('uploadProgress', progress => {
					if (progress.transferred > uploadLimit && progress.percent !== 1) {
						destroy(`Exceeded the upload limit of ${uploadLimit} bytes`);
					}
				});
			}

			return promiseOrStream;
		}
	]
});

// No user agent
const noUserAgent = got.extend({
	headers: {
		'user-agent': undefined
	}
});

// Custom endpoint
const httpbin = got.extend({
	prefixUrl: 'https://httpbin.org/'
});

// Signing requests
import crypto from 'crypto';

const getMessageSignature = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('hex').toUpperCase();
const signRequest = got.extend({
	hooks: {
		beforeRequest: [
			options => {
				const secret = options.context.secret ?? process.env.SECRET;

				if (secret) {
					options.headers['sign'] = getMessageSignature(options.body ?? '', secret);
				}
			}
		]
	}
});

/*
* Putting it all together
*/
const merged = got.extend(
	noUserAgent,
	logger,
	limitDownloadUpload,
	httpbin,
	signRequest,
	controlRedirects
);

// There's no 'user-agent' header :)
const {headers} = await merged.post('anything', {
	body: 'foobar',
	context: {
		secret: 'password'
	}
}).json();

console.log(headers);
// Sending POST to https://httpbin.org/anything
// {
//   Accept: 'application/json',
//   'Accept-Encoding': 'gzip, deflate, br',
//   'Content-Length': '6',
//   Host: 'httpbin.org',
//   Sign: 'EB0167A1EBF205510BAFF5DA1465537944225F0E0140E1880B746F361FF11DCA'
// }

const MEGABYTE = 1048576;
await merged('https://pop-iso.sfo2.cdn.digitaloceanspaces.com/21.04/amd64/intel/5/pop-os_21.04_amd64_intel_5.iso', {
	context: {
		downloadLimit: MEGABYTE
	},
	prefixUrl: ''
});
// CancelError: Exceeded the download limit of 1048576 bytes
