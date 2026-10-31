package agent

import "testing"

func TestEffectiveResourceKindSupportsLegacyDocuments(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		agent *Agent
		want  ResourceKind
	}{
		{name: "explicit standalone", agent: &Agent{Kind: ResourceKindStandaloneAgent}, want: ResourceKindStandaloneAgent},
		{name: "explicit team", agent: &Agent{Kind: ResourceKindAgentTeam}, want: ResourceKindAgentTeam},
		{name: "legacy standalone", agent: &Agent{}, want: ResourceKindStandaloneAgent},
		{
			name:  "legacy team",
			agent: &Agent{Delegates: []DelegateConfig{{AgentID: "member", ToolName: "researcher"}}},
			want:  ResourceKindAgentTeam,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := EffectiveResourceKind(test.agent); got != test.want {
				t.Fatalf("EffectiveResourceKind() = %q, want %q", got, test.want)
			}
		})
	}
}
