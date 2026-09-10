function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return null;
  return (((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0);
}

function inCidr(ip: number, base: string, bits: number): boolean {
  const network = parseIpv4(base);
  if (network == null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (network & mask);
}

export function isBlockedIpv4(ip: string): boolean {
  const value = parseIpv4(ip);
  if (value == null) return true;
  return (
    inCidr(value, "0.0.0.0", 8) ||
    inCidr(value, "10.0.0.0", 8) ||
    inCidr(value, "127.0.0.0", 8) ||
    inCidr(value, "169.254.0.0", 16) ||
    inCidr(value, "172.16.0.0", 12) ||
    inCidr(value, "192.168.0.0", 16) ||
    inCidr(value, "100.64.0.0", 10) ||
    inCidr(value, "192.0.2.0", 24) ||
    inCidr(value, "198.51.100.0", 24) ||
    inCidr(value, "203.0.113.0", 24) ||
    inCidr(value, "224.0.0.0", 4) ||
    inCidr(value, "255.255.255.255", 32)
  );
}

export function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}

export function isBlockedIp(ip: string): boolean {
  if (ip.includes(":")) return isBlockedIpv6(ip);
  return isBlockedIpv4(ip);
}
