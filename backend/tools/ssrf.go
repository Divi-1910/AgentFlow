package tools

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// defaultBlockedCIDRs is the private/internal IP blocklist shared by the HTTP
// tool and the MCP client's URL validation.
func defaultBlockedCIDRs() []*net.IPNet {
	cidrs := []string{
		"127.0.0.0/8",
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"169.254.0.0/16",
		"::1/128",
		"fc00::/7",
		"fe80::/10",
	}
	var blocked []*net.IPNet
	for _, cidr := range cidrs {
		if _, network, err := net.ParseCIDR(cidr); err == nil {
			blocked = append(blocked, network)
		}
	}
	return blocked
}

// checkSSRF rejects non-http(s) schemes, localhost, and hostnames that resolve
// into any blocked (private/internal) CIDR. Shared by the HTTP tool and the MCP
// manager (the latter additionally requires https before calling this).
func checkSSRF(rawURL string, blocked []*net.IPNet) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %s", err.Error())
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("only http and https URLs are allowed, got %q", parsed.Scheme)
	}
	hostname := parsed.Hostname()
	if strings.EqualFold(hostname, "localhost") {
		return fmt.Errorf("requests to localhost are not allowed")
	}
	ips, err := net.LookupHost(hostname)
	if err != nil {
		return fmt.Errorf("could not resolve host %q", hostname)
	}
	for _, ipStr := range ips {
		ip := net.ParseIP(ipStr)
		if ip == nil {
			continue
		}
		for _, network := range blocked {
			if network.Contains(ip) {
				return fmt.Errorf("requests to private/internal IP ranges are not allowed (%s → %s)", hostname, ipStr)
			}
		}
	}
	return nil
}
