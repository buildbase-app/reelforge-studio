/**
 * Reads an `strace -f -yy -e trace=connect,sendto,sendmsg,sendmmsg` log and
 * returns every line that could put a packet on the network outside loopback
 * (#318, D-110). `-yy` labels each socket with its protocol, e.g.
 * `24<UDPv6:[123456]>` (not connected) or `24<UDP:[10.0.0.2:5353->8.8.8.8:53]>`.
 *
 * Counted, whatever the call's result (a host without a route only hides a
 * leak): a connect() to a non-loopback address or to port 53; a send to such an
 * address, given in the call or known from the socket's connect().
 *
 * One exception, Chromium's IPv6 reachability check: before its first host
 * resolution every Chromium connect()s a *UDP* socket to Google's public DNS
 * address 2001:4860:4860::8888, port 443, to learn whether the kernel has an
 * IPv6 route, reads the local address and closes it. A UDP connect() sends no
 * packet (it only looks up a route), and Chrome 157 has no switch that turns
 * the check off. It is allowed only in exactly that form: UDP over IPv6, that
 * address, port 443 (or 80, Chromium's alternative port), and nothing ever sent
 * on that socket. A TCP connection to the same address (DNS over HTTPS) counts.
 */
export const CHROMIUM_IPV6_PROBE = { address: '2001:4860:4860::8888', ports: ['443', '80'] } as const;

const LINE = /^\s*(?:\[pid\s+)?\d+\]?\s+(connect|sendto|sendmsg|sendmmsg)\((\d+)(?:<((?:->|[^>])*)>)?/;
const V4 = /sin_port=htons\((\d+)\), sin_addr=inet_addr\("([^"]+)"\)/;
const V6 = /sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "([^"]+)"/;
/** Remote end in a `-yy` label: `->1.2.3.4:53` or `->[2001:db8::1]:443`. */
const LABEL_PEER = /->\[?([0-9A-Fa-f:.]+?)\]?:(\d+)\]?$/;

function isLoopback(address: string): boolean {
  return /^127\./.test(address) || address === '::1' || /^::ffff:127\./i.test(address);
}

function leaves(address: string, port: string): boolean {
  return !isLoopback(address) || port === '53';
}

export function externalNetworkCalls(log: string): string[] {
  const found: string[] = [];
  /** Socket inode -> where its connect() pointed, for sends on a connected socket. */
  const connectedTo = new Map<string, { address: string; port: string; probe: boolean }>();
  for (const line of log.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [, call, , label = ''] = m as unknown as [string, string, string, string | undefined];
    const proto = /^([A-Za-z0-9]+):/.exec(label)?.[1] ?? '';
    const inode = /^[A-Za-z0-9]+:\[(\d+)\]$/.exec(label)?.[1];
    const addr = V4.exec(line) ?? V6.exec(line);
    const port = addr?.[1];
    const address = addr?.[2];
    if (call === 'connect') {
      if (!address || !port) continue; // AF_UNIX, netlink, AF_UNSPEC (disconnect)
      const probe = proto === 'UDPv6' && address === CHROMIUM_IPV6_PROBE.address && (CHROMIUM_IPV6_PROBE.ports as readonly string[]).includes(port);
      if (inode) connectedTo.set(inode, { address, port, probe });
      if (leaves(address, port) && !probe) found.push(line);
      continue;
    }
    // A send: the destination in the call, else the socket's peer (label or its connect()).
    if (address && port) {
      if (leaves(address, port)) found.push(line);
      continue;
    }
    const peer = LABEL_PEER.exec(label);
    if (peer) {
      if (leaves(peer[1]!, peer[2]!)) found.push(line);
      continue;
    }
    const known = inode ? connectedTo.get(inode) : undefined;
    // Anything sent on the probe socket is a packet to Google: counted too.
    if (known && (leaves(known.address, known.port) || known.probe)) found.push(line);
  }
  return found;
}
