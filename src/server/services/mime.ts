import PostalMime, { type Address, type RawEmail } from "postal-mime";

export const parseEmail = (raw: RawEmail) =>
  PostalMime.parse(raw, {
    maxNestingDepth: 30,
    maxHeadersSize: 1048576,
    maxRfc822NestingDepth: 3,
  });

export const emailAddresses = (items?: Address[]): string[] =>
  items?.flatMap((a) =>
    a.group ? emailAddresses(a.group) : a.address ? [a.address] : [],
  ) || [];
