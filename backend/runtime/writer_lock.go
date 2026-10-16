package main

import (
	"errors"
	"fmt"
	"os"
)

var (
	errManagedStorageLocked          = errors.New("runtime: managed storage is already locked")
	errManagedStorageLockUnsupported = errors.New("runtime: managed storage locking is unsupported on this platform")
)

type managedWriterLock struct {
	file *os.File
}

func acquireManagedWriterLock(metadataDir string) (*managedWriterLock, error) {
	root, err := os.OpenRoot(metadataDir)
	if err != nil {
		return nil, fmt.Errorf("runtime: open managed metadata directory: %w", err)
	}
	file, openErr := root.OpenFile("writer.lock", os.O_CREATE|os.O_RDWR, 0o600)
	rootCloseErr := root.Close()
	if openErr != nil {
		return nil, fmt.Errorf("runtime: open managed writer lock: %w", openErr)
	}
	if rootCloseErr != nil {
		_ = file.Close()
		return nil, fmt.Errorf("runtime: close managed metadata directory: %w", rootCloseErr)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("runtime: secure managed writer lock: %w", err)
	}
	if err := lockFileExclusive(file); err != nil {
		_ = file.Close()
		return nil, err
	}
	return &managedWriterLock{file: file}, nil
}

func (l *managedWriterLock) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	file := l.file
	l.file = nil
	return errors.Join(unlockFile(file), file.Close())
}
