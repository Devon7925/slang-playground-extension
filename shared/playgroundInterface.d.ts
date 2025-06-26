export type CompileRequest = {
	target: 'SPIRV' | 'METAL' | 'WGSL',
	sourceCode: string,
	noWebGPU: boolean,
}

export type ServerInitializationOptions = {
	extensionUri: string,
	workspaceUri: string,
}

export type ScalarType = `${"uint" | "int"}${8 | 16 | 32 | 64}` | `${"float"}${16 | 32 | 64}`;

export type SlangFormat = "rgba32f" | "rgba16f" | "rg32f" | "rg16f" | "r11f_g11f_b10f" | "r32f" | "r16f" | "rgba16" | "rgb10_a2" | "rgba8" | "rg16" | "rg8" | "r16" | "r8" | "rgba16_snorm" | "rgba8_snorm" | "rg16_snorm" | "rg8_snorm" | "r16_snorm" | "r8_snorm" | "rgba32i" | "rgba16i" | "rgba8i" | "rg32i" | "rg16i" | "rg8i" | "r32i" | "r16i" | "r8i" | "rgba32ui" | "rgba16ui" | "rgb10_a2ui" | "rgba8ui" | "rg32ui" | "rg16ui" | "rg8ui" | "r32ui" | "r16ui" | "r8ui" | "64ui" | "r64i" | "bgra8"

export type Bindings = {[k:string]: GPUBindGroupLayoutEntry};
export type HashedStringData = { [hash: number]: string }

export type ReflectionBinding = {
	"kind": "uniform",
	"offset": number,
	"size": number,
} | {
	"kind": "descriptorTableSlot",
	"index": number,
};

export type ReflectionType = {
	"kind": "struct",
	"name": string,
	"fields": ReflectionParameter[]
} | {
	"kind": "vector",
	"elementCount": 2 | 3 | 4,
	"elementType": ReflectionType,
} | {
	"kind": "scalar",
	"scalarType": ScalarType,
} | {
	"kind": "resource",
	"baseShape": "structuredBuffer",
	"access"?: "readWrite",
	"resultType": ReflectionType,
} | {
	"kind": "resource",
	"baseShape": "texture2D",
	"access"?: "readWrite" | "write",
	"resultType": ReflectionType,
} | {
	"kind": "samplerState",
};

export type ReflectionParameter = {
	"binding": ReflectionBinding,
	"format"?: SlangFormat,
	"name": string,
	"type": ReflectionType,
	"userAttribs"?: ReflectionUserAttribute[],
}

export type ReflectionJSON = {
	"entryPoints": ReflectionEntryPoint[],
	"parameters": ReflectionParameter[],
	"hashedStrings": { [str: string]: number },
};

export type ReflectionEntryPoint = {
	"name": string,
	"parameters": ReflectionParameter[],
	"stage": string,
	"threadGroupSize": [number, number, number],
	"userAttribs"?: ReflectionUserAttribute[],
};

export type ReflectionUserAttribute = {
	"arguments": (number | string)[],
	"name": string,
};

export type CompilationResult = null | [string, Bindings, HashedStringData, ReflectionJSON, { [key: string]: [number, number, number] }];

export type Shader = {
    succ: true,
    code: string,
    layout: Bindings,
    hashedStrings: HashedStringData,
    reflection: ReflectionJSON,
    threadGroupSizes: { [key: string]: [number, number, number] },
};

export type MaybeShader = Shader | {
    succ: false
};

export type PlaygroundRun = {
	userSource: string,
	ret: Shader,
}