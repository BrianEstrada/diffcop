// Base64, since the data could hold `-->` and end the HTML comment early.
const MARKER = /^<!-- diffcop:([a-z]+)=([A-Za-z0-9+/=]+) -->$/;

// The data of the `name` marker among the lines a comment ends with. Only those count: the
// review's text above them can quote a marker, and whoever wrote the code under review chose it.
export function trailingMarker(body: string, name: string) {
  const lines = body.trimEnd().split(/\r?\n/);
  for (const line of lines.toReversed()) {
    const match = MARKER.exec(line);
    if (!match) {
      return undefined;
    }
    if (match[1] === name) {
      return match[2];
    }
  }
  return undefined;
}
