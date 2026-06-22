package sqliterepo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type rowScanner interface {
	Scan(dest ...any) error
}

func unixNano(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UTC().UnixNano()
}

func timeFromUnixNano(v int64) time.Time {
	if v == 0 {
		return time.Time{}
	}
	return time.Unix(0, v).UTC()
}

func nullableUnixNano(t *time.Time) any {
	if t == nil {
		return nil
	}
	return unixNano(*t)
}

func timeFromNull(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := timeFromUnixNano(v.Int64)
	return &t
}

func encodeJSON(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	b, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode JSON: %w", err)
	}
	return string(b), nil
}

func decodeJSON(raw sql.NullString, dst any) error {
	if !raw.Valid || raw.String == "" || raw.String == "null" {
		return nil
	}
	if err := json.Unmarshal([]byte(raw.String), dst); err != nil {
		return fmt.Errorf("decode JSON: %w", err)
	}
	return nil
}

type sqliteCoder interface {
	Code() int
}

func constraintCode(err error) (int, bool) {
	var coded sqliteCoder
	if !errors.As(err, &coded) {
		return 0, false
	}
	code := coded.Code()
	return code, code&0xff == 19
}

func isConstraint(err error) bool {
	_, ok := constraintCode(err)
	return ok
}
