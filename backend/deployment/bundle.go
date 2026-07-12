package deployment

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"backend/agent"
	"backend/llm"
	"backend/tools"
)

const SchemaVersion = 1

var (
	providerNameRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	envNameRE      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	hashRE         = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type Bundle struct {
	SchemaVersion int           `json:"schema_version"`
	DeploymentID  string        `json:"deployment_id"`
	ConfigHash    string        `json:"config_hash"`
	RootAgentID   string        `json:"root_agent_id"`
	PlatformXML   string        `json:"platform_xml"`
	Agents        []BundleAgent `json:"agents"`
}

type BundleAgent struct {
	ID                 string            `json:"id"`
	Name               string            `json:"name"`
	Description        string            `json:"description"`
	Provider           string            `json:"provider"`
	Model              string            `json:"model"`
	SystemPrompt       string            `json:"system_prompt"`
	Tools              []string          `json:"tools"`
	Delegates          []BundleDelegate  `json:"delegates"`
	MCPServers         []BundleMCPServer `json:"mcp_servers"`
	ModelContextLimit  int               `json:"model_context_limit"`
	ContextWindow      int               `json:"context_window"`
	ContextKeepRatio   float64           `json:"context_keep_ratio"`
	SummarizationModel string            `json:"summarization_model"`
	MaxSteps           int               `json:"max_steps"`
	Temperature        float64           `json:"temperature"`
	MaxTokens          int               `json:"max_tokens"`
	MaxRuns            int               `json:"max_runs"`
}

type BundleDelegate struct {
	AgentID      string `json:"agent_id"`
	ToolName     string `json:"tool_name"`
	Description  string `json:"description"`
	Instructions string `json:"instructions"`
}

type BundleMCPServer struct {
	Alias     string `json:"alias"`
	URL       string `json:"url"`
	BearerEnv string `json:"bearer_env"`
}

// Read decodes and statically validates a bundle without checking its declared
// hash or environment. This is used by hash-config before the final hash exists.
func Read(path string) (*Bundle, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("deployment: open bundle: %w", err)
	}
	defer f.Close()

	var b Bundle
	dec := json.NewDecoder(f)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return nil, fmt.Errorf("deployment: decode bundle: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		if err == nil {
			err = fmt.Errorf("multiple JSON values")
		}
		return nil, fmt.Errorf("deployment: trailing content: %w", err)
	}
	b.normalize()
	if err := b.ValidateStatic(); err != nil {
		return nil, err
	}
	return &b, nil
}

func Load(path string) (*Bundle, error) {
	b, err := Read(path)
	if err != nil {
		return nil, err
	}
	if err := b.VerifyHash(); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *Bundle) normalize() {
	if b.Agents == nil {
		b.Agents = []BundleAgent{}
	}
	for i := range b.Agents {
		if b.Agents[i].Tools == nil {
			b.Agents[i].Tools = []string{}
		}
		if b.Agents[i].Delegates == nil {
			b.Agents[i].Delegates = []BundleDelegate{}
		}
		if b.Agents[i].MCPServers == nil {
			b.Agents[i].MCPServers = []BundleMCPServer{}
		}
	}
}

type hashPayload struct {
	SchemaVersion int           `json:"schema_version"`
	DeploymentID  string        `json:"deployment_id"`
	RootAgentID   string        `json:"root_agent_id"`
	PlatformXML   string        `json:"platform_xml"`
	Agents        []BundleAgent `json:"agents"`
}

func (b *Bundle) CanonicalHash() (string, error) {
	normalized := *b
	normalized.Agents = append([]BundleAgent(nil), b.Agents...)
	normalized.normalize()
	payload, err := json.Marshal(hashPayload{
		SchemaVersion: normalized.SchemaVersion,
		DeploymentID:  normalized.DeploymentID,
		RootAgentID:   normalized.RootAgentID,
		PlatformXML:   normalized.PlatformXML,
		Agents:        normalized.Agents,
	})
	if err != nil {
		return "", fmt.Errorf("deployment: canonicalize bundle: %w", err)
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

func (b *Bundle) VerifyHash() error {
	if !hashRE.MatchString(b.ConfigHash) {
		return fmt.Errorf("deployment: config_hash must be 64 lowercase hexadecimal characters")
	}
	actual, err := b.CanonicalHash()
	if err != nil {
		return err
	}
	if actual != b.ConfigHash {
		return fmt.Errorf("deployment: config hash mismatch: declared %s, computed %s", b.ConfigHash, actual)
	}
	return nil
}

func (b *Bundle) SyntheticUserID() string {
	if len(b.ConfigHash) < 32 {
		return ""
	}
	return "runtime_" + b.ConfigHash[:32]
}

func (b *Bundle) ValidateStatic() error {
	if b.SchemaVersion != SchemaVersion {
		return fmt.Errorf("deployment: unsupported schema_version %d (want %d)", b.SchemaVersion, SchemaVersion)
	}
	if strings.TrimSpace(b.DeploymentID) == "" || strings.TrimSpace(b.RootAgentID) == "" {
		return fmt.Errorf("deployment: deployment_id and root_agent_id are required")
	}
	if strings.TrimSpace(b.PlatformXML) == "" {
		return fmt.Errorf("deployment: platform_xml is required")
	}
	if len(b.Agents) == 0 {
		return fmt.Errorf("deployment: at least one agent is required")
	}

	byID := make(map[string]BundleAgent, len(b.Agents))
	for _, a := range b.Agents {
		if err := validateAgent(a); err != nil {
			return err
		}
		if _, exists := byID[a.ID]; exists {
			return fmt.Errorf("deployment: duplicate agent id %q", a.ID)
		}
		byID[a.ID] = a
	}
	if _, ok := byID[b.RootAgentID]; !ok {
		return fmt.Errorf("deployment: root agent %q not found", b.RootAgentID)
	}
	for _, a := range b.Agents {
		for _, d := range a.Delegates {
			if _, ok := byID[d.AgentID]; !ok {
				return fmt.Errorf("deployment: agent %q delegates to missing agent %q", a.ID, d.AgentID)
			}
			if d.AgentID == a.ID {
				return fmt.Errorf("deployment: agent %q cannot delegate to itself", a.ID)
			}
		}
	}
	return validateGraph(b.RootAgentID, byID)
}

func validateAgent(a BundleAgent) error {
	if !validSegment(a.ID) {
		return fmt.Errorf("deployment: invalid agent id %q", a.ID)
	}
	if strings.TrimSpace(a.Name) == "" || strings.TrimSpace(a.Provider) == "" || strings.TrimSpace(a.Model) == "" || strings.TrimSpace(a.SystemPrompt) == "" {
		return fmt.Errorf("deployment: agent %q requires name, provider, model, and system_prompt", a.ID)
	}
	if a.ModelContextLimit <= 0 || a.ContextWindow <= 0 || a.MaxSteps <= 0 || a.MaxTokens <= 0 || a.MaxRuns <= 0 {
		return fmt.Errorf("deployment: agent %q has non-positive runtime limits", a.ID)
	}
	if a.ContextKeepRatio <= 0 || a.ContextKeepRatio > 1 {
		return fmt.Errorf("deployment: agent %q context_keep_ratio must be in (0,1]", a.ID)
	}
	if a.Temperature < 0 {
		return fmt.Errorf("deployment: agent %q temperature must be non-negative", a.ID)
	}
	seenTools := map[string]struct{}{}
	for _, name := range a.Tools {
		if !providerNameRE.MatchString(name) {
			return fmt.Errorf("deployment: agent %q has invalid tool name %q", a.ID, name)
		}
		if _, ok := seenTools[name]; ok {
			return fmt.Errorf("deployment: agent %q has duplicate tool %q", a.ID, name)
		}
		seenTools[name] = struct{}{}
	}
	seenDelegates := map[string]struct{}{}
	for _, d := range a.Delegates {
		if !providerNameRE.MatchString(d.ToolName) {
			return fmt.Errorf("deployment: agent %q has invalid delegate tool %q", a.ID, d.ToolName)
		}
		if _, ok := seenDelegates[d.ToolName]; ok {
			return fmt.Errorf("deployment: agent %q has duplicate delegate tool %q", a.ID, d.ToolName)
		}
		seenDelegates[d.ToolName] = struct{}{}
	}
	seenAliases := map[string]struct{}{}
	for _, s := range a.MCPServers {
		if !providerNameRE.MatchString(s.Alias) || strings.TrimSpace(s.URL) == "" {
			return fmt.Errorf("deployment: agent %q has invalid MCP server %q", a.ID, s.Alias)
		}
		if _, ok := seenAliases[s.Alias]; ok {
			return fmt.Errorf("deployment: agent %q has duplicate MCP alias %q", a.ID, s.Alias)
		}
		seenAliases[s.Alias] = struct{}{}
		if s.BearerEnv != "" && !envNameRE.MatchString(s.BearerEnv) {
			return fmt.Errorf("deployment: agent %q has invalid bearer_env %q", a.ID, s.BearerEnv)
		}
	}
	return nil
}

func validSegment(s string) bool {
	if s == "" || len(s) > 128 || s == "." || s == ".." || strings.ContainsAny(s, `/\\`) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validateGraph(root string, agents map[string]BundleAgent) error {
	state := make(map[string]uint8, len(agents))
	reachable := make(map[string]bool, len(agents))
	var visit func(string) error
	visit = func(id string) error {
		if state[id] == 1 {
			return fmt.Errorf("deployment: delegation cycle includes agent %q", id)
		}
		if state[id] == 2 {
			return nil
		}
		state[id] = 1
		reachable[id] = true
		for _, d := range agents[id].Delegates {
			if err := visit(d.AgentID); err != nil {
				return err
			}
		}
		state[id] = 2
		return nil
	}
	if err := visit(root); err != nil {
		return err
	}
	for id := range agents {
		if !reachable[id] {
			return fmt.Errorf("deployment: agent %q is unreachable from root %q", id, root)
		}
	}
	return nil
}

func (b *Bundle) ValidateEnvironment(lookup func(string) (string, bool)) error {
	return b.ValidateEnvironmentWith(lookup, tools.ValidateMCPServerURL)
}

// ValidateEnvironmentWith validates secret references and MCP URLs using
// caller-supplied process/environment boundaries. Production passes the real
// OS lookup and HTTPS/SSRF validator; composition tests inject equivalents
// without weakening the builder's single validation choke point.
func (b *Bundle) ValidateEnvironmentWith(lookup func(string) (string, bool), validateURL func(string) error) error {
	if lookup == nil {
		lookup = os.LookupEnv
	}
	if validateURL == nil {
		validateURL = tools.ValidateMCPServerURL
	}
	for _, a := range b.Agents {
		for _, s := range a.MCPServers {
			if s.BearerEnv != "" {
				value, ok := lookup(s.BearerEnv)
				if !ok || strings.TrimSpace(value) == "" {
					return fmt.Errorf("deployment: agent %q MCP server %q requires nonempty environment variable %s", a.ID, s.Alias, s.BearerEnv)
				}
			}
			if err := validateURL(s.URL); err != nil {
				return fmt.Errorf("deployment: agent %q MCP server %q: %w", a.ID, s.Alias, err)
			}
		}
	}
	return nil
}

func (b *Bundle) ValidateRuntime(registry *tools.ToolRegistry, providers *llm.LLMRegistry, capabilities agent.ToolCapabilities) error {
	for _, cfg := range b.Agents {
		a := cfg.Agent()
		if _, err := providers.Get(a.Provider); err != nil {
			return fmt.Errorf("deployment: agent %q provider: %w", a.ID, err)
		}
		if _, err := agent.BuildToolSetForValidation(registry, a, capabilities); err != nil {
			return fmt.Errorf("deployment: agent %q tool set: %w", a.ID, err)
		}
	}
	return nil
}

func (a BundleAgent) Agent() *agent.Agent {
	delegates := make([]agent.DelegateConfig, len(a.Delegates))
	for i, d := range a.Delegates {
		delegates[i] = agent.DelegateConfig{AgentID: d.AgentID, ToolName: d.ToolName, Description: d.Description, Instructions: d.Instructions}
	}
	servers := make([]agent.MCPServerConfig, len(a.MCPServers))
	for i, s := range a.MCPServers {
		servers[i] = agent.MCPServerConfig{Alias: s.Alias, URL: s.URL, BearerEnv: s.BearerEnv}
	}
	return &agent.Agent{
		ID: a.ID, Name: a.Name, Description: a.Description, Provider: a.Provider, Model: a.Model,
		SystemPrompt: a.SystemPrompt, Tools: append([]string(nil), a.Tools...), Delegates: delegates, MCPServers: servers,
		ModelContextLimit: a.ModelContextLimit, ContextWindow: a.ContextWindow, ContextKeepRatio: a.ContextKeepRatio,
		SummarizationModel: a.SummarizationModel, MaxSteps: a.MaxSteps, Temperature: a.Temperature,
		MaxTokens: a.MaxTokens, MaxRuns: a.MaxRuns,
	}
}
