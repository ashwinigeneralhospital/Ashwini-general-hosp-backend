import { randomInt } from 'crypto';

const randomDigits = (digits: number): string => {
  const max = 10 ** digits;
  return randomInt(0, max).toString().padStart(digits, '0');
};

interface UniqueIdOptions {
  delimiter?: string;
  attempts?: number;
}

export const generateUniquePrefixedId = async (
  prefix: string,
  digits: number,
  existsFn: (id: string) => Promise<boolean>,
  options: UniqueIdOptions = {},
): Promise<string> => {
  const { delimiter = '', attempts = 15 } = options;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const suffix = randomDigits(digits);
    const candidate = delimiter ? `${prefix}${delimiter}${suffix}` : `${prefix}${suffix}`;
    const exists = await existsFn(candidate);
    if (!exists) {
      return candidate;
    }
  }

  throw new Error(`Unable to generate unique ID for prefix ${prefix}`);
};
