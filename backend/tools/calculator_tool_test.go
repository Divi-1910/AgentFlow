package tools

import (
	"math"
	"testing"
)

func TestEvaluate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		expr    string
		want    float64
		wantErr bool
	}{
		// Basic arithmetic
		{name: "adds two integers", expr: "2+3", want: 5},
		{name: "subtracts integers", expr: "10-4", want: 6},
		{name: "multiplies integers", expr: "3*4", want: 12},
		{name: "divides integers evenly", expr: "15/3", want: 5},

		// Operator precedence
		{name: "multiplication binds tighter than addition", expr: "2+3*4", want: 14},
		{name: "parentheses override precedence", expr: "(2+3)*4", want: 20},
		{name: "nested parentheses evaluate correctly", expr: "((2+3)*2)+1", want: 11},

		// Power
		{name: "raises integer to positive power", expr: "2^3", want: 8},
		{name: "raising to zero yields one", expr: "5^0", want: 1},
		{name: "power is right-associative", expr: "2^2^3", want: 256}, // 2^(2^3) = 2^8

		// Square root
		{name: "square root of perfect square", expr: "sqrt(9)", want: 3},
		{name: "square root of zero yields zero", expr: "sqrt(0)", want: 0},
		{name: "sqrt combined with addition", expr: "sqrt(4)+1", want: 3},

		// Unary negation
		{name: "negates a literal", expr: "-5", want: -5},
		{name: "negates a parenthesised expression", expr: "-(3+4)", want: -7},
		{name: "double negation yields positive", expr: "--5", want: 5},

		// Floats
		{name: "adds decimal numbers", expr: "1.5+2.5", want: 4},
		{name: "division produces a decimal result", expr: "7/2", want: 3.5},

		// Whitespace
		{name: "ignores spaces around operators", expr: "2 + 3 * 4", want: 14},

		// Error cases
		{name: "rejects division by zero", expr: "1/0", wantErr: true},
		{name: "rejects sqrt of negative number", expr: "sqrt(-1)", wantErr: true},
		{name: "rejects unclosed parenthesis", expr: "(2+3", wantErr: true},
		{name: "rejects unknown identifier", expr: "foo+1", wantErr: true},
		{name: "rejects empty expression", expr: "", wantErr: true},
		{name: "rejects trailing garbage after valid expression", expr: "2+3x", wantErr: true},
		{name: "rejects missing right operand after operator", expr: "2+", wantErr: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := evaluate(tc.expr)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("evaluate(%q): want error, got %v", tc.expr, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("evaluate(%q): unexpected error: %v", tc.expr, err)
			}
			if math.Abs(got-tc.want) > 1e-9 {
				t.Errorf("evaluate(%q) = %g, want %g", tc.expr, got, tc.want)
			}
		})
	}
}
