package agent

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

const (
	maxPresentationArgumentBytes = 64 * 1024
	maxPresentationFieldRunes    = 4000
)

func buildToolPresentation(meta *ToolMeta, args json.RawMessage, result string) *ToolPresentation {
	if meta == nil {
		return nil
	}
	running, completed, failed := toolPresentationLabels(meta)
	presentation := &ToolPresentation{
		RunningLabel:   running,
		CompletedLabel: completed,
		FailedLabel:    failed,
		Summary:        toolPresentationSummary(meta, args),
		Input:          toolPresentationInput(meta, args),
	}
	if strings.TrimSpace(result) != "" {
		resultValue := safePresentationResult(meta, result)
		presentation.Output = []ToolPresentationField{{
			Label:  "Result",
			Value:  resultValue,
			Format: "text",
		}}
	}
	return presentation
}

func safePresentationResult(meta *ToolMeta, result string) string {
	if meta != nil && meta.Name == "http_request" {
		return "Response received; body hidden"
	}
	trimmed := strings.TrimSpace(result)
	var decoded any
	if len(trimmed) <= maxPresentationArgumentBytes && json.Unmarshal([]byte(trimmed), &decoded) == nil {
		return truncatePresentationValue(presentationString(redactPresentationValue("", decoded)))
	}
	return truncatePresentationValue(trimmed)
}

func toolPresentationLabels(meta *ToolMeta) (string, string, string) {
	operation := strings.ToLower(meta.Operation)
	switch meta.Kind {
	case ToolKindMemory:
		labels := map[string][3]string{
			"write":   {"Saving this to memory", "Saved this to memory", "Could not save this to memory"},
			"read":    {"Reading from memory", "Read from memory", "Could not read from memory"},
			"search":  {"Searching memory", "Searched memory", "Could not search memory"},
			"patch":   {"Editing a memory", "Edited a memory", "Could not edit the memory"},
			"update":  {"Updating a memory", "Updated a memory", "Could not update the memory"},
			"retire":  {"Retiring a memory", "Retired a memory", "Could not retire the memory"},
			"restore": {"Restoring a memory", "Restored a memory", "Could not restore the memory"},
			"history": {"Reviewing memory history", "Reviewed memory history", "Could not review memory history"},
		}
		if label, ok := labels[operation]; ok {
			return label[0], label[1], label[2]
		}
	case ToolKindScratchpad:
		labels := map[string][3]string{
			"create":          {"Creating a shared workspace", "Created a shared workspace", "Could not create the shared workspace"},
			"append_section":  {"Adding findings to the workspace", "Added findings to the workspace", "Could not add findings to the workspace"},
			"replace_section": {"Updating the shared workspace", "Updated the shared workspace", "Could not update the shared workspace"},
			"list":            {"Checking the shared workspace", "Checked the shared workspace", "Could not check the shared workspace"},
			"get_sections":    {"Reviewing workspace sections", "Reviewed workspace sections", "Could not review workspace sections"},
			"read_section":    {"Reading the shared workspace", "Read the shared workspace", "Could not read the shared workspace"},
			"search":          {"Searching the shared workspace", "Searched the shared workspace", "Could not search the shared workspace"},
		}
		if label, ok := labels[operation]; ok {
			return label[0], label[1], label[2]
		}
	case ToolKindDelegate:
		target := "another agent"
		if meta.TargetAgentID != "" {
			target = meta.TargetAgentID
		}
		return "Asking " + target + " for help", "Received work from " + target, "Could not complete delegated work"
	case ToolKindAsync:
		if meta.Name == AsyncToolDispatchAgent {
			return "Dispatching agent work", "Dispatched agent work", "Could not dispatch agent work"
		}
		if meta.Name == AsyncToolAwaitJob {
			return "Waiting for delegated work", "Received delegated work", "Delegated work did not complete"
		}
	case ToolKindMCP:
		server := strings.TrimSpace(meta.MCPAlias)
		if server == "" {
			server = "MCP"
		}
		action := strings.ToLower(humanizeToolName(meta.Operation))
		return fmt.Sprintf("Using %s to %s", server, action), fmt.Sprintf("Used %s to %s", server, action), fmt.Sprintf("%s could not %s", server, action)
	}

	labels := map[string][3]string{
		"calculator":   {"Calculating", "Calculated the result", "Could not calculate the result"},
		"web_search":   {"Searching the web", "Searched the web", "Could not search the web"},
		"http_request": {"Contacting an external service", "Contacted an external service", "Could not contact the external service"},
	}
	if label, ok := labels[meta.Name]; ok {
		return label[0], label[1], label[2]
	}
	name := humanizeToolName(meta.Name)
	return "Using " + name, "Used " + name, "Could not use " + name
}

func toolPresentationSummary(meta *ToolMeta, args json.RawMessage) string {
	values := decodePresentationArgs(args)
	switch meta.Name {
	case "memory_write", "memory_update", "memory_patch", "memory_retire", "memory_restore", "memory_read", "memory_history":
		return joinPresentationValues(values, "scope", "type", "memory_id")
	case "memory_search":
		return presentationString(values["pattern"])
	case "web_search":
		return presentationString(values["query"])
	case "calculator":
		return presentationString(values["expression"])
	case "http_request":
		return strings.TrimSpace(joinPresentationValues(values, "method", "url"))
	}
	if meta.Kind == ToolKindMCP {
		return strings.TrimSpace(strings.Join([]string{meta.MCPAlias, humanizeToolName(meta.Operation)}, " · "))
	}
	if meta.Kind == ToolKindDelegate && meta.TargetAgentID != "" {
		return meta.TargetAgentID
	}
	return ""
}

func toolPresentationInput(meta *ToolMeta, args json.RawMessage) []ToolPresentationField {
	values := decodePresentationArgs(args)
	if len(values) == 0 {
		return nil
	}

	var keys []string
	switch meta.Name {
	case "memory_write":
		keys = []string{"content", "scope", "type", "importance", "ttl_days", "memory_id"}
	case "memory_update":
		keys = []string{"memory_id", "scope", "content", "reason", "expected_revision"}
	case "memory_patch":
		keys = []string{"memory_id", "scope", "edits", "reason", "expected_revision"}
	case "memory_read":
		keys = []string{"memory_id", "scope", "revision"}
	case "memory_search":
		keys = []string{"pattern", "scope", "type", "limit", "include_retired"}
	case "memory_retire":
		keys = []string{"memory_id", "scope", "reason", "expected_revision"}
	case "memory_restore":
		keys = []string{"memory_id", "scope", "from_revision", "reason", "expected_revision"}
	case "memory_history":
		keys = []string{"memory_id", "scope"}
	case "scratchpad_create":
		keys = []string{"title", "heading", "content"}
	case "scratchpad_append_section":
		keys = []string{"file_id", "heading", "content"}
	case "scratchpad_replace_section":
		keys = []string{"file_id", "section_id", "heading", "content"}
	case "scratchpad_list":
		return nil
	case "scratchpad_get_sections":
		keys = []string{"file_id"}
	case "scratchpad_read_section":
		keys = []string{"file_id", "section_id"}
	case "scratchpad_search":
		keys = []string{"pattern", "limit"}
	case "calculator":
		keys = []string{"expression"}
	case "web_search":
		keys = []string{"query", "max_results"}
	case "http_request":
		return httpPresentationFields(values)
	default:
		keys = sortedPresentationKeys(values)
	}

	fields := make([]ToolPresentationField, 0, len(keys))
	for _, key := range keys {
		value, ok := values[key]
		if !ok || value == nil {
			continue
		}
		fields = append(fields, ToolPresentationField{
			Label:  humanizeToolName(key),
			Value:  truncatePresentationValue(presentationString(redactPresentationValue(key, value))),
			Format: presentationFormat(value),
		})
	}
	return fields
}

func httpPresentationFields(values map[string]any) []ToolPresentationField {
	fields := make([]ToolPresentationField, 0, 4)
	for _, key := range []string{"method", "url"} {
		if value := presentationString(values[key]); value != "" {
			fields = append(fields, ToolPresentationField{Label: humanizeToolName(key), Value: truncatePresentationValue(value)})
		}
	}
	if headers, ok := values["headers"].(map[string]any); ok && len(headers) > 0 {
		names := sortedPresentationKeys(headers)
		fields = append(fields, ToolPresentationField{Label: "Headers", Value: strings.Join(names, ", ") + " (values hidden)"})
	}
	if presentationString(values["body"]) != "" {
		fields = append(fields, ToolPresentationField{Label: "Body", Value: "Request body hidden"})
	}
	return fields
}

func decodePresentationArgs(args json.RawMessage) map[string]any {
	if len(args) == 0 || len(args) > maxPresentationArgumentBytes {
		return nil
	}
	var values map[string]any
	if err := json.Unmarshal(args, &values); err != nil {
		return nil
	}
	return values
}

func redactPresentationValue(key string, value any) any {
	if isSensitivePresentationKey(key) {
		return "[redacted]"
	}
	switch typed := value.(type) {
	case map[string]any:
		redacted := make(map[string]any, len(typed))
		for childKey, childValue := range typed {
			redacted[childKey] = redactPresentationValue(childKey, childValue)
		}
		return redacted
	case []any:
		redacted := make([]any, len(typed))
		for i, childValue := range typed {
			redacted[i] = redactPresentationValue("", childValue)
		}
		return redacted
	default:
		return value
	}
}

func isSensitivePresentationKey(key string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
	for _, fragment := range []string{"authorization", "api_key", "apikey", "token", "secret", "password", "passwd", "cookie", "credential"} {
		if strings.Contains(normalized, fragment) {
			return true
		}
	}
	return false
}

func presentationString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(typed)
	default:
		body, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return string(body)
	}
}

func presentationFormat(value any) string {
	switch value.(type) {
	case map[string]any, []any:
		return "json"
	default:
		return "text"
	}
}

func sortedPresentationKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func joinPresentationValues(values map[string]any, keys ...string) string {
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		if value := strings.TrimSpace(presentationString(values[key])); value != "" {
			parts = append(parts, value)
		}
	}
	return strings.Join(parts, " · ")
}

func humanizeToolName(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "_", " "))
	if value == "" {
		return "tool"
	}
	runes := []rune(value)
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}

func truncatePresentationValue(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= maxPresentationFieldRunes {
		return string(runes)
	}
	return string(runes[:maxPresentationFieldRunes]) + "\n… (truncated)"
}

func presentationMetadata(presentation *ToolPresentation) map[string]any {
	if presentation == nil {
		return nil
	}
	body, err := json.Marshal(presentation)
	if err != nil {
		return nil
	}
	var value map[string]any
	if err := json.Unmarshal(body, &value); err != nil {
		return nil
	}
	return value
}
