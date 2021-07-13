import got from '../../dist/source/index.js';

const packageJson = {
	name: 'gh-got',
	version: '12.0.0'
};

const getRateLimit = (headers) => ({
	limit: Number.parseInt(headers['x-ratelimit-limit'], 10),
	remaining: Number.parseInt(headers['x-ratelimit-remaining'], 10),
	reset: new Date(Number.parseInt(headers['x-ratelimit-reset'], 10) * 1000)
});

const instance = got.extend({
	prefixUrl: 'https://api.github.com',
	headers: {
		accept: 'application/vnd.github.v3+json',
		'user-agent': `${packageJson.name}/${packageJson.version}`
	},
	responseType: 'json',
	context: {
		token: process.env.GITHUB_TOKEN,
	},
	hooks: {
		init: [
			(raw, options) => {
				if ('token' in raw) {
					options.context.token = raw.token;
					delete raw.token;
				}
			}
		]
	},
	handlers: [
		(options, next) => {
			// Authorization
			const {token} = options.context;
			if (token && !options.headers.authorization) {
				options.headers.authorization = `token ${token}`;
			}

			// Don't touch streams
			if (options.isStream) {
				return next(options);
			}

			// Magic begins
			return (async () => {
				try {
					const response = await next(options);

					// Rate limit for the Response object
					response.rateLimit = getRateLimit(response.headers);

					return response;
				} catch (error) {
					const {response} = error;

					// Nicer errors
					if (response && response.body) {
						error.name = 'GitHubError';
						error.message = `${response.body.message} (${response.statusCode} status code)`;
					}

					// Rate limit for errors
					if (response) {
						error.rateLimit = getRateLimit(response.headers);
					}

					throw error;
				}
			})();
		}
	]
});

export default instance;
