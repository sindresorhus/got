import { Got, NormalizedOptions } from '.';

export default function extend(got: Got): Got {
  return got.extend({
    hooks: {
      beforeRequest: [
        (options: NormalizedOptions): void => {
          // confirmed that options.responseType is present in `options`, so the type is incorrect
          options.responseType = 'buffer';
        },
      ],
    },
  });
}
