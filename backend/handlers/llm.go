package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type LLMHandler struct {
	LLMRegistry *mongo.Collection
}

func (lh *LLMHandler) GetModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	cursor, err := lh.LLMRegistry.Find(context.TODO(), bson.M{})
	if err != nil {
		http.Error(w, "Internal Server Error while fetching models", http.StatusInternalServerError)
		return
	}
	defer cursor.Close(context.TODO())

	var models []bson.M
	if err := cursor.All(context.TODO(), &models); err != nil {
		http.Error(w, "Error processing model data", http.StatusInternalServerError)
		return
	}

	// If MongoDB returns nothing, initialize an empty list so JSON is `[]` instead of `null`
	if models == nil {
		models = []bson.M{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(models)

}
