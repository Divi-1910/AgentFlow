package tools

const webSearchCredentialEnvName = "TAVILY_API_KEY"

var credentialEnvNamesByTool = map[string][]string{
	"web_search": {webSearchCredentialEnvName},
}

// CredentialEnvNames returns the AgentFlow-owned runtime credential names
// required by an embedded tool. An empty result means that the tool requires
// no managed credential. The returned slice never shares package storage.
func CredentialEnvNames(toolName string) []string {
	return append([]string(nil), credentialEnvNamesByTool[toolName]...)
}
