package tools

import "encoding/json"

func toolJSONResult(v any) (*ToolResult, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return &ToolResult{Content: string(data)}, nil
}

func toolJSONError(err error) (*ToolResult, error) {
	data, marshalErr := json.Marshal(map[string]string{"error": err.Error()})
	if marshalErr != nil {
		return nil, marshalErr
	}
	return &ToolResult{
		Content: string(data),
		IsError: true,
	}, nil
}
