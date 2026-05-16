package tools

import (
	"testing"
	"time"
)

func newTestHTTPTool() *HTTPTool {
	return NewHTTPTool(5*time.Second, newDedupCache(nil, "test"))
}

func TestCheckSSRF(t *testing.T) {
	t.Parallel()

	tool := newTestHTTPTool()

	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		// Localhost — blocked by string match, no DNS needed
		{name: "blocks localhost by name", url: "http://localhost/api", wantErr: true},
		{name: "blocks localhost case-insensitively", url: "http://LOCALHOST/api", wantErr: true},

		// Non-http schemes — blocked before DNS
		{name: "blocks file scheme", url: "file:///etc/passwd", wantErr: true},
		{name: "blocks ftp scheme", url: "ftp://example.com/file", wantErr: true},

		// Private IPv4 ranges — IP literals resolve without DNS
		{name: "blocks loopback address 127.0.0.1", url: "http://127.0.0.1/path", wantErr: true},
		{name: "blocks loopback address 127.0.0.2", url: "http://127.0.0.2/path", wantErr: true},
		{name: "blocks RFC-1918 10.x.x.x range", url: "http://10.1.2.3/path", wantErr: true},
		{name: "blocks RFC-1918 172.16.x.x range", url: "http://172.16.0.1/path", wantErr: true},
		{name: "blocks RFC-1918 192.168.x.x range", url: "http://192.168.1.100/path", wantErr: true},
		{name: "blocks link-local 169.254.x.x range", url: "http://169.254.0.1/path", wantErr: true},

		// Valid public IP — IP literal resolves without DNS, not in any blocked range
		{name: "allows public IP over http", url: "http://8.8.8.8/", wantErr: false},
		{name: "allows public IP over https", url: "https://8.8.8.8/", wantErr: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := tool.checkSSRF(tc.url)
			if tc.wantErr && err == nil {
				t.Errorf("checkSSRF(%q): want error, got nil", tc.url)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("checkSSRF(%q): unexpected error: %v", tc.url, err)
			}
		})
	}
}
