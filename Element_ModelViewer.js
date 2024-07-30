import * as Pop from './PopEngine/PopEngine.js'
import {CreateCubeGeometry} from './PopEngine/CommonGeometry.js'
import Camera from './PopEngine/Camera.js'
import ParseGltf from './PopEngine/PopGltf.js/Gltf.js'
import DragAndDropHandler from './PopEngine/HtmlDragAndDropHandler.js'
import * as PopMath from './PopEngine/Math.js'
import {MatrixMultiply4x4,CreateTranslationMatrix,CreateTranslationQuaternionMatrix,CreateIdentityMatrix,MatrixInverse4x4,TransformPosition} from './PopEngine/Math.js'

const GltfExtensions = ['gltf','glb'];


const CubeSize = 0.01;

function GetRgbaArray(Rgba)
{
	function PadArray0001(a)
	{
		while ( a.length < 3 )
			a.push(0);
		while ( a.length < 4 )
			a.push(1);
		return a;
	}
	
	//	if it's a string, assume [x,y,z] json
	//	todo: allow HTML strings
	if ( typeof Rgba == typeof '' )
	{
		Rgba = JSON.parse(Rgba);
	}
	
	Rgba = PadArray0001(Rgba);
	return Rgba;
}

function GetSiblingFilename(Filename,SiblingFilename)
{
	const Path = Filename.split('/');
	Path[Path.length-1] = SiblingFilename;
	const NewFilename = Path.join('/');
	return NewFilename;
}

async function LoadGltf(GltfFilename,LoadFileAsStringAsync,LoadFileAsArrayBufferAsync,OnLoadingBuffer,EnumGeometry,EnumActor)
{
	async function LoadFileAsync(Filename)
	{
		//	convert filename to proper path
		const Path = GetSiblingFilename( GltfFilename, Filename );
		return await LoadFileAsArrayBufferAsync(Path);
	}
	
	//	load as binary now for GLB and let gltf parser parse
	const GltfData = await LoadFileAsArrayBufferAsync(GltfFilename);
	const Gltf = await ParseGltf( GltfData, LoadFileAsync, OnLoadingBuffer );
	console.log(Gltf);

	//	load all meshes first
	for ( let GeometryName in Gltf.Geometrys )
	{
		const Geometry = Gltf.Geometrys[GeometryName];
		await EnumGeometry(GeometryName,Geometry);
	}
	
	async function EnumerateScene(Scene)
	{
		const SceneNodeIndexes = Scene.nodes;
		let ActorCount = 0;
		
		async function EnumNode(Node)
		{
			//	eg. camera, joint node
			if ( Node.mesh === undefined )
			{
				console.log(`Scene skipping node "${Node.name}" with no mesh`);
				return;
			}
			
			//const Node = Gltf.Nodes[NodeName];
			const MeshGroup = Gltf.MeshGroups[Node.mesh];
			
			const Actor = {};
			Actor.Uniforms = {};
			
			//	this node has a skeleton!
			if ( Node.skin !== undefined )
			{
				Actor.Skeleton = Gltf.GetSkeleton(Node.skin);
				const FirstAnimation = Gltf.GetAnimationNames()[0];
				if ( FirstAnimation )
					Actor.Animation = Gltf.GetAnimation( FirstAnimation );
			}
			
			//	an actor here, may have multiple meshes!
			//	really need a proper "node" and encompass all parts of an actor (node)
			for ( let GeometryName of MeshGroup.GeometryNames )
			{
				Actor.Geometry = GeometryName;
				await EnumActor(Actor,ActorCount);
			}
			
			ActorCount++;
		}
		
		async function EnumNodeIndex(NodeIndex)
		{
			//	get node
			const Node = Gltf.nodes[NodeIndex];
			await EnumNode(Node);
			
			//	do children
			const ChildIndexes = Node.children || [];
			for ( let ChildIndex of ChildIndexes )
			{
				await EnumNodeIndex(ChildIndex);
			}
		}

		for ( let ChildIndex of SceneNodeIndexes )
		{
			await EnumNodeIndex(ChildIndex);
		}
	}
	
	const DefaultSceneIndex = Gltf.scene || 0;
	const DefaultScene = Gltf.scenes[DefaultSceneIndex];

	await EnumerateScene(DefaultScene);

	
	return Gltf;
}

const BasicVertexShader = 
`#version 300 es
precision highp float;
in vec3 POSITION;
in vec3 NORMAL;
in vec2 TEXCOORD_0;
in vec4 WEIGHTS_0;
in vec4 JOINTS_0;
#define LocalPosition POSITION
#define LocalUv TEXCOORD_0
//#define LocalUv vec2( float(gl_VertexID)/5.0f, float(gl_InstanceID)/5.0f )
#define LocalNormal NORMAL
out vec2 uv;
out vec3 Normal;
out vec4 Weights;
out vec4 Joints;
in vec4 InstancedPosition;
uniform mat4 LocalToWorldTransform;
uniform mat4 WorldToCameraTransform;
uniform mat4 CameraProjectionTransform;
uniform float Time;
#define MAX_JOINTS	70
uniform mat4 WorldToJointMatrixes[MAX_JOINTS];
uniform mat4 JointTransforms[MAX_JOINTS];

#define mat4_Identity	mat4( vec4(1,0,0,0), vec4(0,1,0,0), vec4(0,0,1,0), vec4(0,0,0,1) )
mat4 GetJointTransform(int JointIndex)
{
	if ( JointIndex < 0 )
		return mat4_Identity;

	mat4 Joint0Transform = JointTransforms[JointIndex];
	//	dont apply if (assuming) all zero matrix
	if ( Joint0Transform[3].w != 1.0 )
		return mat4_Identity;
	return Joint0Transform;
}

mat4 GetWorldToJointTransform(int JointIndex)
{
	if ( JointIndex < 0 )
		return mat4_Identity;

	return WorldToJointMatrixes[JointIndex];
}

vec3 GetJointTransformedLocalPosition(int JointIndex,vec4 LocalPosition)
{
	//	move to joint space, then apply the joint->world transform
	vec4 JointPos4 = GetWorldToJointTransform(JointIndex) * LocalPosition;
	mat4 JointToLocalTransform = GetJointTransform(JointIndex);
	vec4 LocalPos4 = JointToLocalTransform * JointPos4;
	return LocalPos4.xyz;// * LocalPos4.www;
}

vec3 GetWeightedJointTransformedLocalPosition(vec4 LocalPosition)
{
	if ( WEIGHTS_0.x == 0.0 || JOINTS_0[0] < 0.0 )
		return LocalPosition.xyz;

	vec3 Position = vec3(0);
	for ( int j=0;	j<4;	j++ )
	{
		float Weight = WEIGHTS_0[j];
		if ( Weight > 0.0 )
			Position += GetJointTransformedLocalPosition( int(JOINTS_0[j]), LocalPosition ) * Weight;
	}
	return Position;
}

void main()
{
	vec3 LocalPos = LocalPosition;
	LocalPos = GetWeightedJointTransformedLocalPosition( vec4(LocalPos,1) );

	vec4 WorldPosition = LocalToWorldTransform * vec4(LocalPos,1);
	WorldPosition.xyz += InstancedPosition.xyz;
	gl_Position = CameraProjectionTransform * WorldToCameraTransform * WorldPosition;
	uv = LocalUv.xy;
	Normal = LocalNormal;
	Normal = GetWeightedJointTransformedLocalPosition( vec4(LocalNormal,0) );
	vec4 NormalWorld = LocalToWorldTransform * vec4(LocalPosition,0);
	//Normal = NormalWorld.xyz;
	Joints = JOINTS_0;
	Weights = WEIGHTS_0;
}
`;
const BasicFragShader =
`#version 300 es
precision highp float;
out vec4 FragColor;
in vec2 uv;
in vec3 Normal;
in vec4 Joints;
in vec4 Weights;

bool IsAlternativeUv()
{
	float GridSize = 0.05;
	vec2 GridUv = mod( uv, GridSize ) / GridSize;
	bool Left = GridUv.x < 0.5;
	bool Top = GridUv.y < 0.5;
	return !(Left==Top);	//	top left and bottom right
}

vec3 GetDebugColour(int x)
{
	x = x % 6;
	if ( x == 0 )	return vec3(1,0,0);
	if ( x == 1 )	return vec3(1,1,0);
	if ( x == 2 )	return vec3(0,1,0);
	if ( x == 3 )	return vec3(0,1,1);
	if ( x == 4 )	return vec3(0,0,1);
	else	return vec3(1,0,1);
}

void main()
{
	float Alpha = 1.0;
	float JointSum = Joints.x + Joints.y + Joints.z + Joints.w;
	float WeightsSum = Weights.x + Weights.y + Weights.z + Weights.w;
	if ( WeightsSum > 0.0 && false )
	{
		vec3 JointColour;
		for ( int j=0;	j<4;	j++ )
			JointColour += GetDebugColour(int(Joints[j])) * Weights[j];

		//FragColor = vec4( GetDebugColour(int(Joints.x)), 0.3 );
		FragColor = vec4( JointColour, Alpha );
		return;
	}
	
	if ( Normal.x + Normal.y + Normal.z != 0.0 )
	{
		//	normal -1...1 to 0...1
		vec3 NormalColour = (Normal + 1.0) / 2.0;
		FragColor = vec4(NormalColour,Alpha);
		return;
	}
	bool AlternativeColour = IsAlternativeUv();
	float Blue = AlternativeColour?1.0:0.0;
	FragColor = vec4(uv,Blue,Alpha);
}
`;


function SetupCameraControl(RenderView,Camera)
{
	const PanMult = 2;
	const ZoomMult = 1;//20;
	const AutoRotateWithMouse = false;
	
	RenderView.OnMouseScroll = function(x,y,Button,Scroll)
	{
		const Zoom = Scroll[1] * -ZoomMult;// * 0.1;
		//if ( Button == 'Left' )
		{
			Camera.OnCameraZoom( Zoom );
		}
		//Pop.Debug(`ControlCamera_MouseWheel(${Array.from(arguments)})`);
	}

	RenderView.OnMouseMove = function(x,y,Button)
	{
		x *= PanMult;
		y *= PanMult;
		
		if ( Button == 'Left' )
			Camera.OnCameraOrbit( -x, y, 0 );
		else if ( Button == 'Right' )
			Camera.OnCameraPanLocal( -x, y, 0 );
		else if ( Button == 'Middle' )
			Camera.OnCameraPanLocal( -x, 0, y );
		else if ( AutoRotateWithMouse )
			Camera.OnCameraOrbit( -x, y*0.1, 0 );
		//Pop.Debug(`ControlCamera_MouseMove(${Array.from(arguments)})`);
	}

	RenderView.OnMouseDown = function(x,y,Button)
	{
		x *= PanMult;
		y *= PanMult;
		
		if ( Button == 'Left' )
			Camera.OnCameraOrbit( -x, y, 0, true );
		if ( Button == 'Right' )
			Camera.OnCameraPanLocal( -x, y, 0, true );
		if ( Button == 'Middle' )
			Camera.OnCameraPanLocal( -x, 0, y, true );
	}
	
	RenderView.OnMouseUp = function(){}
}


/*
	Renderer with
	input:
	- Model name
	- Marker position
	- Model Transform (scale, pos, rot)
	output:
	- Transform
*/
export default class ModelViewer extends HTMLElement 
{
	#SceneCount = 0;
	
	constructor()
	{
		super();

		this.Assets = {};	//	render assets
		this.Actors = [];
		
		//	hold onto all loaded animations
		this.Animations = {};
		
		//	cache of files for drag & drop
		this.Files = {};	//	[Filename] = File
	}
	
	
	//	reflect our properties
	static get observedAttributes() 
	{
		return ['transform','modelFilename'];
	}
	get transform()
	{
		const TransformString = this.hasAttribute('transform') ? this.getAttribute('finishedLabel') : "[]";	
		const TransformArray = JSON.parse(TransformString);
		//	should be array
		return TransformArray;
	}
	set transform(TransformArray)	
	{
		//	should be array
		const TransformString = JSON.stringify(TransformArray);
		this.setAttribute('transform', TransformString);
	}
	
	get modelFilename()				{	return this.hasAttribute('modelFilename') ? this.getAttribute('modelFilename') : null;	}
	set modelFilename(NewFilename)	
	{
		if ( !NewFilename )
			this.removeAttribute('modelFilename');	
		else
			this.setAttribute('modelFilename', NewFilename);
		this.ReloadModel();
	}
	
	get clearColour()
	{
		let RgbaString = this.getAttribute('clearColour');
		try
		{
			let Rgba = GetRgbaArray(RgbaString);
			return Rgba;
		}
		catch(e)
		{
			console.warn(`Invalid clear colour(${RgbaString}); ${e}`);
			return [1.0,0.0,1.0,1.0];	//	magenta/pink for error
		}
	}
	set clearColour(Rgba)	
	{
		//	should be array
		Rgba = GetRgbaArray(Rgba);
		const RgbaString = JSON.stringify(Rgba);
		this.setAttribute('clearColour', RgbaString);
	}
	
	get ClearSceneOnNewFile()	{	return false;	}
	
	async OnDroppedFiles(NewFiles)
	{
		//	save all the files, then try and load any with model filenames
		for ( let DroppedFile of NewFiles )
		{
			this.Files[DroppedFile.Name] = DroppedFile.Contents;
		}
		function IsModelFilename(File)
		{
			const FileExtension = File.Name.split('.').pop().toLowerCase();
			return GltfExtensions.includes(FileExtension);
		}
		const FirstModelFile = NewFiles.find( IsModelFilename );
		if ( !FirstModelFile )
			throw `Dropped files but couldn't find a model to load`;
			
		this.modelFilename = FirstModelFile.Name;
	}
	
	async LoadFileAsStringAsync(Filename)
	{
		let CacheContents = this.Files[Filename];
		if ( CacheContents )
		{
			if ( typeof CacheContents != typeof '' )
				CacheContents = Pop.BytesToString(CacheContents);
			return CacheContents;
		}
			
		return Pop.FileSystem.LoadFileAsStringAsync(Filename);
	}
	
	async LoadFileAsArrayBufferAsync(Filename)
	{
		const CacheContents = this.Files[Filename];
		if ( CacheContents )
			return CacheContents;
			
		return Pop.FileSystem.LoadFileAsArrayBufferAsync(Filename);
	}
	

	MakeCanvas()
	{
		const Canvas = document.createElement('canvas');
		
		//	set canvas resolution
		//	make these variables
		Canvas.width = 640;
		Canvas.height = 480;
		return Canvas;
	}

	SetupDom(Parent)
	{
		this.Canvas = this.MakeCanvas();

		this.StatusBox = document.createElement('div');
		this.StatusBox.className = 'StatusBox';
		this.StatusLabel = document.createElement('div');
		this.StatusLabel.innerText = null;
		this.StatusLabel.className = 'StatusLabel';
		this.ErrorLabel = document.createElement('div');
		this.ErrorLabel.innerText = null;
		this.ErrorLabel.className = 'ErrorLabel';

		// Create some CSS to apply to the shadow dom
		const Style = document.createElement('style');
		Style.textContent = `
		:host /* shadow dom root, this can be overridden by whatever is embedding this */
		{
			xbackground:		#0f0;
			padding:		0px;
			margin:			0px;
			position:		relative;
		}
		
		/* make both full-size absolute so they can overlap */
		canvas, 
		.StatusBox
		{
			position:		absolute;
			top:			0px;
			xright:			0px;
			xbottom:		0px;
			left:			0px;
			min-height:		100px;
			border:			none;
			width:			100%;
			height:			100%;
		}
		
		canvas
		{
			cursor:	pointer;
		}
		
		canvas[Dragging=true]
		{
			border:	10px dashed #c99;
		}
		
		/* container for labels so we can easily center*/
		.StatusBox
		{
			display:			flex;
			flex-direction:		column;
			align-content:		center;
			justify-content:	center;
			align-items:		center;
			pointer-events:		none;
		}
		
		.StatusLabel,
		.ErrorLabel
		{
			opacity:			0.8;
			background:			#f99;
			color:				#fff;
			border:				1px white solid;
			padding:			0.5em;
			margin:				0.5em;
			border-radius:		0.5em;
			pointer-events:		auto;
		}
		.StatusLabel
		{
			background:		#99f;
		}
		
		.StatusLabel:empty,
		.ErrorLabel:empty
		{
			display:	none;
		}
		
		
		/***********/`;
		
		// attach the created elements to the shadow dom
		Parent.appendChild(Style);
		Parent.appendChild(this.Canvas);
		Parent.appendChild(this.StatusBox);
		this.StatusBox.appendChild(this.StatusLabel);
		this.StatusBox.appendChild(this.ErrorLabel);
	}
	
	SetupRenderer(Canvas)
	{
		this.RenderView = new Pop.Gui.RenderView('Model',Canvas);
		this.RenderContext = new Pop.Opengl.Context(this.RenderView);
		this.Camera = new Camera();
		this.Camera.LookAt = [ 0,1,0 ];
		this.Camera.Position = [ 0,1,4 ];

		//	bind mouse events to camera control
		SetupCameraControl(this.RenderView,this.Camera);
		
		//
		this.RenderThread();
	}
		
	attributeChangedCallback(name, oldValue, newValue) 
	{
		if ( name == 'modelFilename' )
			this.ReloadModel();
	}
	
	connectedCallback()
	{
		//	Create a shadow root
		const Shadow = this.attachShadow({mode: 'open'});
		this.SetupDom(Shadow);
		this.SetupRenderer(this.Canvas);

		this.DragAndDropThread(this.Canvas);

		//	initialise clear colour if it hasn't been set
		this.clearColour = this.clearColour;
		this.ReloadModel();
	}
	
	disconnectedCallback()
	{
		//	cleanup render view & render context
		console.log(`Cleaning up model viewer...`);
		if ( this.RenderContext )
			this.RenderContext.Close();
		this.RenderContext = null;
	}
	
	OnStatus(Status)
	{
		this.StatusLabel.innerText = Status;
	}
	
	OnError(Error)
	{
		this.ErrorLabel.innerText = Error ? `${Error}` : null;
		if ( Error )
			this.OnClickedClose();
	}	
		
	OnClickedFinished(Event)
	{
		if ( !this.onfinished )
		{
			console.warn(`onfinished(${this.value}) No onfinished attribute set`);
			return;
		}
		
		const Result = this.GetResultValue();
		this.onfinished(Result);
	}
	
	OnClickedClose(Event)
	{
		if ( !this.onclose )
		{
			console.warn(`OnClickedClose(${this.value}) No onclose attribute set`);
			return;
		}

		this.onclose(this.value);
	}
	
	GetResultValue()
	{
		//	gr; should this return a canvas? bytes? base64 encoded image?
		return this.Canvas;
	}
	
	OnUserChangedValue()
	{
		if ( !this.onchange )
		{
			console.warn(`OnUserChangedValue(${this.value}) No onchange attribute set`);
			return;
		}

		this.onchange(this.GetResultValue());
	}
	
	ReloadModel()
	{
		console.log(`Queue new model to load ${this.modelFilename}`);
		
		//	clear old error
		this.OnError(null);

		this.PendingModelFilename = this.modelFilename;
	}
	
	async DragAndDropThread(AttachToElement)
	{
		function OnDragStart()
		{
			//	gr: shadow dom's dont have attributes!
			if ( AttachToElement.setAttribute )
				AttachToElement.setAttribute('Dragging','true');
		}
		function OnDragEnd()
		{
			//	gr: shadow dom's dont have attributes!
			if ( AttachToElement.removeAttribute )
				AttachToElement.removeAttribute('Dragging');
		}
		
		const Handler = new DragAndDropHandler( AttachToElement, OnDragStart, OnDragEnd );
		while ( true )
		{
			const DroppedFiles = await Handler.WaitForDragAndDropFiles();
			await this.OnDroppedFiles(DroppedFiles);
		}
	}
	
	async LoadAssets(RenderContext)
	{
		if ( !this.Assets['Shader'] )
		{
			this.Assets['Shader'] = await RenderContext.CreateShader( BasicVertexShader, BasicFragShader );
		}
		
		if ( !this.Assets['Cube'] )
		{
			const Geo = CreateCubeGeometry(-CubeSize,CubeSize);
			
			//	rename pop attributes to GLTF names
			Geo.POSITION = Geo.LocalPosition;
			Geo.NORMAL = Geo.LocalNormal;
			Geo.TEXCOORD_0 = Geo.LocalUv;
			this.Assets['Cube'] = await RenderContext.CreateGeometry( Geo, null );
		}

		if ( this.PendingModelFilename )
		{
			//	delete old actors
			if ( this.ClearSceneOnNewFile )
			{
				this.Actors = [];
				this.#SceneCount = 0;
			}
				
			
			//	pop pending value so another thread can replace it again
			const Filename = this.PendingModelFilename;
			this.PendingModelFilename = null;
			
			//	save any new animations, to apply to previous skeletons for testing
			const NewAnimations = [];
			
			//	wrap load calls with status update
			const LoadStringAsync = async function(Filename)
			{
				this.OnStatus(`Loading ${Filename}...`);
				return this.LoadFileAsStringAsync(...arguments);
			}
			const LoadBufferAsync = async function(Filename)
			{
				this.OnStatus(`Loading ${Filename}...`);
				return this.LoadFileAsArrayBufferAsync(...arguments);
			}
			function OnLoadingBuffer(Filename)
			{
				this.OnStatus(`Loading ${Filename}...`);
			}

			async function PushGeometry(Name,Geometry)
			{
				//const Geo = CreateCubeGeometry(0,1);
				if ( Geometry.Attribs.JOINTS_0 )
				{
					const JOINTS_0 = Geometry.Attribs.JOINTS_0;
					const JointSet = {};
					for ( let i=0;	i<JOINTS_0.Data.length;	i+=4 )
					{
						let j0123 = JOINTS_0.Data.slice(i,i+4);
						let j0 = j0123[0];
						JointSet[j0] = true;
					}
					console.log(`JOINTS_0 used; ${Object.keys(JointSet)}`);
				}
				this.Assets[Name] = await RenderContext.CreateGeometry( Geometry.Attribs, Geometry.TriangleIndexes );
			}
			
			async function PushActor(Actor,SceneNodeIndex)
			{
				let z = SceneNodeIndex * 0;
				let x = this.#SceneCount;
				Actor.Translation = Actor.Translation || [x,0,z];
				
				
				function GeneratePosition(_,Index)
				{
					let Rows = 40;
					let x = Index % Rows;
					let z = Math.floor(Index/Rows);
					x *= 2;
					z *= -2;
					return [x,0,z,1];
				}
				const LotsOfPositions = [...new Array(1)].map(GeneratePosition).flat(1);
				Actor.Uniforms.InstancedPosition = new Float32Array(LotsOfPositions);

				//	if the actor has a skeleton, make a sibling actor
				//	gr: i believe a node can only have 1 skin...
				//		doesnt make sense to have multiple skins for one scene object
				const ActorCubeForJoints = false;
				if ( Actor.Skeleton && ActorCubeForJoints )
				{
					try
					{
						function AddJoint(Joint,JointIndex)
						{
							const CubeActor = {};
							CubeActor.Geometry = 'Cube';
							CubeActor.Translation = Joint.Translation;
							CubeActor.Translation[2] += z;
							CubeActor.Rotation = Joint.Rotation;
							CubeActor.Uniforms = {};
							
							JointIndex = Joint.JointIndex;
							//	popengine gl system allows attributes to be defined in uniforms, will auto-instance data
							CubeActor.Uniforms.JOINTS_0 = [JointIndex,JointIndex,JointIndex,JointIndex];
							this.Actors.push(CubeActor);
						}
						
						//	skeletons are trees of joints
						//	- joints have names, as well as indexes, to match vertex attributes
						//	- tree produces bones
						Actor.Skeleton.Joints.forEach( AddJoint.bind(this) );
					}
					catch(e)
					{
						console.error(`Error loading skeleton; ${e}`);
					}
				}

				if ( Actor.Skeleton )
				{
					Actor.Uniforms.WorldToJointMatrixes = Actor.Skeleton.WorldToJointMatrixes;
					//Actor.Uniforms.JointToWorldMatrixes = Actor.Skeleton.JointToWorldMatrixes;
				}
				
				//if ( !Actor.Skeleton )
					this.Actors.push(Actor);
			}
			try
			{
				const Gltf = await LoadGltf( Filename, LoadStringAsync.bind(this), LoadBufferAsync.bind(this), OnLoadingBuffer.bind(this), PushGeometry.bind(this), PushActor.bind(this) );
				
				for ( let AnimationName of Gltf.GetAnimationNames() )
				{
					const Animation = Gltf.GetAnimation(AnimationName);
					this.Animations[AnimationName] = Animation;
				}
				
				if ( this.Actors.length == 0 )
					throw `GLTF loaded without error, but didn't add any actors.`;
				this.OnStatus(`Loaded ${Filename}`);
				this.OnStatus(null);
			}
			catch(e)
			{
				this.OnError(e);

				const CubeActor = {};
				CubeActor.Geometry = 'Cube';
				CubeActor.Translation = [0,0,0];
				this.Actors.push(CubeActor);
			}
			
			this.#SceneCount++;
		}
			
		
		return this.Assets;
	}
	
	GetRenderCommands(Assets,ScreenRect)
	{
		const ScreenViewport = [0,0,ScreenRect[2],ScreenRect[3]];
		const Commands = [];
		let Time = (Pop.GetTimeNowMs()/1000) % 10;

		//const ClearColour = [Time,1,0];
		const ClearColour = this.clearColour;
		Commands.push(['SetRenderTarget',null,ClearColour]);
		
		
		for ( let Actor of this.Actors )
		{
			const Camera = this.Camera;
			const Geometry = Assets[Actor.Geometry];
			const Shader = Assets.Shader;
			
			if ( !Geometry || !Shader )
				continue;
			
			const Uniforms = Object.assign({},Actor.Uniforms);
			const RenderViewport = ScreenViewport;
			const WorldToCameraMatrix = Camera.GetWorldToCameraMatrix();
			const CameraProjectionMatrix = Camera.GetProjectionMatrix( RenderViewport );
			const ScreenToCameraTransform = PopMath.MatrixInverse4x4( CameraProjectionMatrix );
			const CameraToWorldTransform = PopMath.MatrixInverse4x4( WorldToCameraMatrix );
			const LocalToWorldTransform = PopMath.CreateTranslationMatrix( ...Actor.Translation );
			const WorldToLocalTransform = PopMath.MatrixInverse4x4(LocalToWorldTransform);
			Uniforms.LocalToWorldTransform = LocalToWorldTransform;
			Uniforms.WorldToCameraTransform = WorldToCameraMatrix;
			Uniforms.CameraProjectionTransform = CameraProjectionMatrix;
			Uniforms.Time = Time;
			
			if ( Actor.Skeleton )
			{
				let AnimationFrame = null;
				//if ( Actor.Animation )
				const Animation = Object.values(this.Animations)[0];
				if ( Animation )
				{
					const ClipLength = Animation.LastKeyframeTime;
					Time = (Pop.GetTimeNowMs()/1000) % ClipLength;
					AnimationFrame = Animation.GetFrame(Time);
				}
				const JointWorldTransforms = Actor.Skeleton.GetJointWorldTransforms( AnimationFrame );
				Uniforms.JointTransforms = JointWorldTransforms;
				
				const DrawJointCubes = false;
				
				//	draw a cube at each joint
				function DrawJoint(Joint,JointIndex)
				{
					const Geo = Assets['Cube'];
					const UseNoJoints = false;	//	just use joint transform directly, for testing
					const NewUniforms = Object.assign( {}, Uniforms );

					if ( UseNoJoints )
					{
						//NewUniforms.LocalToWorldTransform = LocalToWorldTransform;
						NewUniforms.LocalToWorldTransform = JointTransforms[JointIndex];
						NewUniforms.JointTransforms = [];
						
						//	popengine gl system allows attributes to be defined in uniforms, will auto-instance data
						NewUniforms.JOINTS_0 = [-1,-1,-1,-1];
						NewUniforms.WEIGHTS_0 = [0,0,0,0];
					}
					else
					{
						const Identity4x4 = CreateIdentityMatrix();
						NewUniforms.WorldToJointMatrixes = NewUniforms.WorldToJointMatrixes.map( (v,Index) => Identity4x4[Index%16] );
						//NewUniforms.LocalToWorldTransform = CreateIdentityMatrix();
						NewUniforms.JOINTS_0 = [JointIndex,JointIndex,JointIndex,JointIndex];
						NewUniforms.WEIGHTS_0 = [1,0,0,0];
					}
					
					Commands.push(['Draw',Geo,Shader,NewUniforms]);
				}
				if ( DrawJointCubes )
					Actor.Skeleton.Joints.forEach( DrawJoint.bind(this) );
			}
			
			Commands.push(['Draw',Geometry,Shader,Uniforms]);
		}
		
		return Commands;
	}
	
	async RenderThread()
	{
		while( this.RenderContext )
		{
			try
			{
				const Assets = await this.LoadAssets(this.RenderContext);
				//	commonly disapears here so avoid exception
				if ( !this.RenderContext )
					continue;
				const ScreenRect = this.RenderContext.GetScreenRect();
				const RenderCommands = this.GetRenderCommands(Assets,ScreenRect);
				await this.RenderContext.Render(RenderCommands);
			}
			catch(e)
			{
				console.warn(`RenderThread Error; ${e}, throttling...`);
				await Pop.Yield(1000);
			}
		}
	}
}


export const ElementName = 'model-viewer';

//	name requires dash!
window.customElements.define(ElementName, ModelViewer);
