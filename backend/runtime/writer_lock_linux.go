//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func lockFileExclusive(file *os.File) error {
	err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, syscall.EWOULDBLOCK), errors.Is(err, syscall.EAGAIN):
		return fmt.Errorf("%w: %s", errManagedStorageLocked, file.Name())
	default:
		return fmt.Errorf("runtime: acquire managed writer lock: %w", err)
	}
}

func unlockFile(file *os.File) error {
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_UN); err != nil {
		return fmt.Errorf("runtime: release managed writer lock: %w", err)
	}
	return nil
}
