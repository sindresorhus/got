import got from '../../dist/source/index.js';
import Bourne from '@hapi/bourne';

const max = Date.now() - 1000 * 86400 * 7;

const iterator = got.paginate('https://api.github.com/repos/sindresorhus/got/commits', {
	pagination: {
		paginate: ({response, currentItems}) => {
			// If there are no more data, finish.
			if (currentItems.length === 0) {
				return false;
			}

			// Get the current page number.
			const {searchParams} = response.request.options;
			const previousPage = Number(searchParams.get('page') ?? 1);

			// Update the page number by one.
			return {
				searchParams: {
					page: previousPage + 1
				}
			};
		},
		// Using `Bourne` to prevent prototype pollution.
		transform: response => Bourne.parse(response.body),
		filter: ({item}) => {
			// Check if the commit time exceeds our range.
			const date = new Date(item.commit.committer.date);
			const end = date.getTime() - max >= 0;

			return end;
		},
		shouldContinue: ({item}) => {
			// Check if the commit time exceeds our range.
			const date = new Date(item.commit.committer.date);
			const end = date.getTime() - max >= 0;

			return end;
		},
		// We want only 50 results.
		countLimit: 50,
		// Wait 1s before making another request to prevent API rate limiting.
		backoff: 1000,
		// It is a good practice to set an upper limit of how many requests can be made.
		// This way we can avoid infinite loops.
		requestLimit: 10,
		// In this case, we don't need to store all the items we receive.
		// They are processed immediately.
		stackAllItems: false
	}
});

console.log('Last 50 commits from now to week ago:');
for await (const item of iterator) {
	console.log(item.commit.message.split('\n')[0]);
}
