package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type SQLiteOptions struct {
	JournalMode string
	BusyTimeout time.Duration
}

// OpenSQLite owns SQLite connection setup. Repository packages own migrations
// and queries; callers close the returned pool when the runtime shuts down.
func OpenSQLite(path string, opts SQLiteOptions) (*sql.DB, error) {
	if path == "" {
		return nil, fmt.Errorf("sqlite: database path is required")
	}
	journalMode := strings.ToUpper(strings.TrimSpace(opts.JournalMode))
	if journalMode == "" {
		journalMode = "WAL"
	}
	busyTimeout := opts.BusyTimeout
	if busyTimeout <= 0 {
		busyTimeout = 5 * time.Second
	}

	db, err := sql.Open("sqlite", sqliteDSN(path, journalMode, busyTimeout))
	if err != nil {
		return nil, fmt.Errorf("sqlite: open: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	ctx, cancel := context.WithTimeout(context.Background(), busyTimeout+5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("sqlite: ping: %w", err)
	}
	if err := verifySQLitePragmas(ctx, db, journalMode, busyTimeout); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func sqliteDSN(path, journalMode string, busyTimeout time.Duration) string {
	base := path
	if path == ":memory:" {
		base = "file::memory:"
	} else if !strings.HasPrefix(path, "file:") {
		base = "file:" + filepath.ToSlash(path)
	}
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	params := url.Values{}
	params.Add("_pragma", "busy_timeout("+strconv.FormatInt(busyTimeout.Milliseconds(), 10)+")")
	params.Add("_pragma", "foreign_keys(1)")
	params.Add("_pragma", "journal_mode("+journalMode+")")
	params.Set("_txlock", "immediate")
	return base + sep + params.Encode()
}

func verifySQLitePragmas(ctx context.Context, db *sql.DB, journalMode string, busyTimeout time.Duration) error {
	var actualBusy int64
	if err := db.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&actualBusy); err != nil {
		return fmt.Errorf("sqlite: verify busy_timeout: %w", err)
	}
	if actualBusy != busyTimeout.Milliseconds() {
		return fmt.Errorf("sqlite: busy_timeout=%d, want %d", actualBusy, busyTimeout.Milliseconds())
	}
	var foreignKeys int
	if err := db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		return fmt.Errorf("sqlite: verify foreign_keys: %w", err)
	}
	if foreignKeys != 1 {
		return fmt.Errorf("sqlite: foreign_keys disabled")
	}
	var actualJournal string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&actualJournal); err != nil {
		return fmt.Errorf("sqlite: verify journal_mode: %w", err)
	}
	if !strings.EqualFold(actualJournal, journalMode) {
		return fmt.Errorf("sqlite: journal_mode=%s, want %s", actualJournal, journalMode)
	}
	return nil
}
