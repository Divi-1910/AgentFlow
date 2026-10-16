//go:build !linux

package main

import (
	"fmt"
	"os"
)

func lockFileExclusive(_ *os.File) error {
	return errManagedStorageLockUnsupported
}

func unlockFile(_ *os.File) error {
	return fmt.Errorf("%w", errManagedStorageLockUnsupported)
}
