import fs from 'fs';
import got from '../../dist/source/index.js';

const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const getRateLimit = headers => ({
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
	token: process.env.GITHUB_TOKEN,
	handlers: [
		(options, next) => {
			// Authorization
			if (options.token && !options.headers.authorization) {
				options.headers.authorization = `token ${options.token}`;
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
