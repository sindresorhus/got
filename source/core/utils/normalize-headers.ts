import {Headers} from '..';

export default (input: Headers): Headers => {
	const output: Headers = {};
	const entries = Object.entries(input);
	/* If there are multiple keys that are equal, except for capitalization,
	   then use the last key's capitalization
	 */
	const usedKeys = new Set();
	for (let i = entries.length - 1; i >= 0; i--) {
		const [key, value] = entries[i];
		const lowercaseKey = key.toLowerCase();
		if (!usedKeys.has(lowercaseKey)) {
			output[key] = value;
			usedKeys.add(lowercaseKey);
		}
	}

	return output;
};
