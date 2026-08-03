package runner

const ProtocolVersion = 1

type Request struct {
	Version   int               `json:"version"`
	Command   string            `json:"command"`
	Args      []string          `json:"args,omitempty"`
	Cwd       string            `json:"cwd"`
	Env       map[string]string `json:"env,omitempty"`
	TimeoutMS uint32            `json:"timeout_ms,omitempty"`
}
