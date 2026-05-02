package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
)

type rgEnvelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type rgMatchData struct {
	Path       rgText `json:"path"`
	LineNumber int    `json:"line_number"`
}

type rgText struct {
	Text string `json:"text"`
}

func SearchCandidates(ctx context.Context, rgPath, pattern string, files []string, bodyStartLines map[string]int) (map[string]int, error) {
	if len(files) == 0 {
		return map[string]int{}, nil
	}

	args := []string{"--json", "-F", "-i", "-n", "--", pattern}
	args = append(args, files...)

	cmd := exec.CommandContext(ctx, rgPath, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return map[string]int{}, nil
		}
		return nil, fmt.Errorf("memory: rg failed: %w: %s", err, stderr.String())
	}

	hits := make(map[string]int)
	for _, line := range bytes.Split(stdout.Bytes(), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var env rgEnvelope
		if err := json.Unmarshal(line, &env); err != nil {
			return nil, fmt.Errorf("memory: parse rg output: %w", err)
		}
		if env.Type != "match" {
			continue
		}

		var data rgMatchData
		if err := json.Unmarshal(env.Data, &data); err != nil {
			return nil, fmt.Errorf("memory: parse rg match: %w", err)
		}

		bodyStart, ok := bodyStartLines[data.Path.Text]
		if !ok || data.LineNumber < bodyStart {
			continue
		}
		if _, exists := hits[data.Path.Text]; !exists {
			hits[data.Path.Text] = data.LineNumber
		}
	}

	return hits, nil
}
