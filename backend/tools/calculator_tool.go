package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"unicode"

	"backend/llm"
)

type CalculatorTool struct{}

func NewCalculatorTool() *CalculatorTool { return &CalculatorTool{} }

func (t *CalculatorTool) Name() string { return "calculator" }

func (t *CalculatorTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        "calculator",
		Description: "Evaluates a mathematical expression and returns the result. Supports +, -, *, /, ^ (power), sqrt(), and parentheses.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"expression": {
					"type": "string",
					"description": "A mathematical expression. Example: sqrt(144) + 5*8"
				}
			},
			"required": ["expression"]
		}`),
	}
}

type calcArgs struct {
	Expression string `json:"expression"`
}

func (t *CalculatorTool) Execute(_ context.Context, args json.RawMessage) (*ToolResult, error) {
	var input calcArgs
	if err := json.Unmarshal(args, &input); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidArgs, err.Error())
	}
	if strings.TrimSpace(input.Expression) == "" {
		return nil, fmt.Errorf("%w: expression is required", ErrInvalidArgs)
	}

	result, err := evaluate(input.Expression)
	if err != nil {
		return &ToolResult{
			Content: fmt.Sprintf("[tool: calculator]\nError: %s", err.Error()),
			IsError: true,
		}, nil
	}

	return &ToolResult{
		Content: fmt.Sprintf("[tool: calculator]\nResult: %g", result),
	}, nil
}

type parser struct {
	input []rune
	pos   int
}

func evaluate(expr string) (float64, error) {
	p := &parser{input: []rune(strings.TrimSpace(expr))}
	result, err := p.parseExpression()
	if err != nil {
		return 0, err
	}
	p.skipWhitespace()
	if p.pos < len(p.input) {
		return 0, fmt.Errorf("unexpected character: %q", string(p.input[p.pos]))
	}
	return result, nil
}

func (p *parser) skipWhitespace() {
	for p.pos < len(p.input) && unicode.IsSpace(p.input[p.pos]) {
		p.pos++
	}
}

func (p *parser) peek() (rune, bool) {
	p.skipWhitespace()
	if p.pos >= len(p.input) {
		return 0, false
	}
	return p.input[p.pos], true
}

func (p *parser) parseExpression() (float64, error) {
	left, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		ch, ok := p.peek()
		if !ok || (ch != '+' && ch != '-') {
			break
		}
		p.pos++
		right, err := p.parseTerm()
		if err != nil {
			return 0, err
		}
		if ch == '+' {
			left += right
		} else {
			left -= right
		}
	}
	return left, nil
}

func (p *parser) parseTerm() (float64, error) {
	left, err := p.parsePower()
	if err != nil {
		return 0, err
	}
	for {
		ch, ok := p.peek()
		if !ok || (ch != '*' && ch != '/') {
			break
		}
		p.pos++
		right, err := p.parsePower()
		if err != nil {
			return 0, err
		}
		if ch == '*' {
			left *= right
		} else {
			if right == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			left /= right
		}
	}
	return left, nil
}

func (p *parser) parsePower() (float64, error) {
	base, err := p.parseUnary()
	if err != nil {
		return 0, err
	}
	ch, ok := p.peek()
	if ok && ch == '^' {
		p.pos++
		exp, err := p.parseUnary()
		if err != nil {
			return 0, err
		}
		return math.Pow(base, exp), nil
	}
	return base, nil
}

func (p *parser) parseUnary() (float64, error) {
	ch, ok := p.peek()
	if ok && ch == '-' {
		p.pos++
		val, err := p.parseUnary()
		return -val, err
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() (float64, error) {
	p.skipWhitespace()
	if p.pos >= len(p.input) {
		return 0, fmt.Errorf("unexpected end of expression")
	}

	// sqrt(...)
	if p.pos+4 <= len(p.input) && strings.ToLower(string(p.input[p.pos:p.pos+4])) == "sqrt" {
		p.pos += 4
		p.skipWhitespace()
		if p.pos >= len(p.input) || p.input[p.pos] != '(' {
			return 0, fmt.Errorf("expected '(' after sqrt")
		}
		p.pos++
		val, err := p.parseExpression()
		if err != nil {
			return 0, err
		}
		p.skipWhitespace()
		if p.pos >= len(p.input) || p.input[p.pos] != ')' {
			return 0, fmt.Errorf("missing closing ')' for sqrt")
		}
		p.pos++
		if val < 0 {
			return 0, fmt.Errorf("sqrt of negative number")
		}
		return math.Sqrt(val), nil
	}

	ch := p.input[p.pos]

	if ch == '(' {
		p.pos++
		val, err := p.parseExpression()
		if err != nil {
			return 0, err
		}
		p.skipWhitespace()
		if p.pos >= len(p.input) || p.input[p.pos] != ')' {
			return 0, fmt.Errorf("missing closing parenthesis")
		}
		p.pos++
		return val, nil
	}

	if unicode.IsDigit(ch) || ch == '.' {
		return p.parseNumber()
	}

	return 0, fmt.Errorf("unexpected character: %q", string(ch))
}

func (p *parser) parseNumber() (float64, error) {
	start := p.pos
	hasDot := false
	for p.pos < len(p.input) {
		ch := p.input[p.pos]
		if unicode.IsDigit(ch) {
			p.pos++
		} else if ch == '.' && !hasDot {
			hasDot = true
			p.pos++
		} else {
			break
		}
	}
	var val float64
	if _, err := fmt.Sscanf(string(p.input[start:p.pos]), "%f", &val); err != nil {
		return 0, fmt.Errorf("invalid number: %s", string(p.input[start:p.pos]))
	}
	return val, nil
}
