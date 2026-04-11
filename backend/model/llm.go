package model

type LLMModel struct {
	ModelID       string `bson:"model_id"      json:"model_id"`
	Name          string `bson:"name"          json:"name"`
	Provider      string `bson:"provider"      json:"provider"`
	APIModelID    string `bson:"api_model_id"  json:"api_model_id"`
	ContextWindow int    `bson:"context_window" json:"context_window"`
}
