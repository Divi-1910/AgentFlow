package model

type LLMModel struct {
	ModelID       string `json:"model_id"`
	Name          string `json:"name"`
	Provider      string `json:"provider"`
	APIModelID    string `json:"api_model_id"`
	ContextWindow int    `json:"context_window"`
}
