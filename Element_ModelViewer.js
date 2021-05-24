import Pop from './PopEngine/PopEngine.js'
import {CreateCubeGeometry} from './PopEngine/CommonGeometry.js'
import Camera from './PopEngine/Camera.js'
//import gltf from './PopEngine/gltf/gltf/gltf.js'
import ParseGltf from './PopEngine/PopGltf.js/Gltf.js'

function GetSiblingFilename(Filename,SiblingFilename)
{
	const Path = Filename.split('/');
	Path[Path.length-1] = SiblingFilename;
	const NewFilename = Path.join('/');
	return NewFilename;
}

async function LoadGltf(GltfFilename,LoadFileAsStringAsync,LoadFileAsArrayBufferAsync,EnumGeometry,EnumActor)
{
	async function LoadFileAsync(Filename)
	{
		//	convert filename to proper path
		const Path = GetSiblingFilename( GltfFilename, Filename );
		return await LoadFileAsArrayBufferAsync(Path);
	}
	
	const GltfJson = await LoadFileAsStringAsync(GltfFilename);
	const GltfObj = JSON.parse( GltfJson );
	const Gltf = await ParseGltf( GltfObj, LoadFileAsync );

	//	load all meshes first
	for ( let GeometryName in Gltf.Geometrys )
	{
		const Geometry = Gltf.Geometrys[GeometryName];
		await EnumGeometry(GeometryName,Geometry);
	}
	
	//	enumerate scene
	for ( let Node of Gltf.nodes )
	{
		//	eg camera
		if ( Node.mesh === undefined )
			continue;
			
		//const Node = Gltf.Nodes[NodeName];
		const MeshGroup = Gltf.MeshGroups[Node.mesh];
		const Actor = {};
		Actor.Uniforms = {};
		for ( let GeometryName of MeshGroup.GeometryNames )
		{
			Actor.Geometry = GeometryName;
			await EnumActor(Actor);
		}
	}
	
	console.log(Gltf);
	return Gltf;
}

const BasicVertexShader = 
`
in vec3 POSITION;
in vec2 TEXCOORD_0;
#define LocalPosition POSITION
#define LocalUv TEXCOORD_0
out vec2 uv;
uniform mat4 LocalToWorldTransform;
uniform mat4 WorldToCameraTransform;
uniform mat4 CameraProjectionTransform;
void main()
{
	gl_Position = CameraProjectionTransform * WorldToCameraTransform * LocalToWorldTransform * vec4(LocalPosition,1);
	uv = LocalUv.xy;
}
`;
const BasicFragShader = `
precision highp float;
varying vec2 uv;
void main()
{
	gl_FragColor = vec4(uv,0,1);
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
	constructor()
	{
		super();

		this.Assets = {};	//	render assets
		this.Actors = [];
		
		//	Create a shadow root
		const Shadow = this.attachShadow({mode: 'open'});
		this.SetupDom(Shadow);
		this.SetupRenderer(this.Canvas);
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

	async LoadFileAsStringAsync(Filename)
	{
		return Pop.FileSystem.LoadFileAsStringAsync(Filename);
	}
	
	async LoadFileAsArrayBufferAsync(Filename)
	{
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
			background:		#0f0;
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
		this.RenderContext = new Pop.Opengl.Context(Canvas);
		this.Camera = new Camera();
		this.Camera.Position = [ 0,1,5 ];
		
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
		this.ReloadModel();
	}
	
	disconnectedCallback()
	{
		//	cleanup render view & render context
		this.RenderContext = null;
	}
	
	OnStatus(Status)
	{
		this.StatusLabel.innerText = Status;
	}
	
	OnError(Error)
	{
		this.ErrorLabel.innerText = `${Error}`;
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
		this.PendingModelFilename = this.modelFilename;
	}
	
	async LoadAssets(RenderContext)
	{
		if ( !this.Assets['Shader'] )
		{
			this.Assets['Shader'] = await RenderContext.CreateShader( BasicVertexShader, BasicFragShader );
		}
		
		if ( !this.Assets['Cube'] )
		{
			const Geo = CreateCubeGeometry(0,1);
			this.Assets['Cube'] = await RenderContext.CreateGeometry( Geo, null );
		}

		if ( this.PendingModelFilename )
		{
			//	delete old actors
			this.Actors = [];
			
			//	pop pending value so another thread can replace it again
			const Filename = this.PendingModelFilename;
			this.PendingModelFilename = null;
			//const Filename = '/Assets/Foo/Avocado/Avocado.gltf';
			//const Filename = '/Assets/Foo/SciFiHelmet/SciFiHelmet.gltf';
			
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

			async function PushGeometry(Name,Geometry)
			{
				//const Geo = CreateCubeGeometry(0,1);
				this.Assets[Name] = await RenderContext.CreateGeometry( Geometry.Attribs, Geometry.TriangleIndexes );
			}
			async function PushActor(Actor)
			{
				this.Actors.push(Actor);
			}
			try
			{
				await LoadGltf( Filename, LoadStringAsync.bind(this), LoadBufferAsync.bind(this), PushGeometry.bind(this), PushActor.bind(this) );
				
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
				this.Actors.push(CubeActor);
			}
		}
			
		return this.Assets; 
	}
	
	GetRenderCommands(Assets,ScreenRect)
	{
		const ScreenViewport = [0,0,ScreenRect[2],ScreenRect[3]];
		const Commands = [];
		const Time = ((Pop.GetTimeNowMs()/1000) % 2)/2;
		//const ClearColour = [Time,1,0];
		const ClearColour = [0.4,0.45,0.5];
		Commands.push(['SetRenderTarget',null,ClearColour]);
		
		/*
		{
			const Geometry = Assets.Cube;
			const Shader = Assets.Shader;
			const Camera = this.Camera;
			const Uniforms = {};
			const PopMath = Pop.Math;
			const RenderViewport = [0,0,1,1];
			const WorldToCameraMatrix = Camera.GetWorldToCameraMatrix();
			const CameraProjectionMatrix = Camera.GetProjectionMatrix( RenderViewport );
			const ScreenToCameraTransform = PopMath.MatrixInverse4x4( CameraProjectionMatrix );
			const CameraToWorldTransform = PopMath.MatrixInverse4x4( WorldToCameraMatrix );
			//const LocalToWorldTransform = Camera.GetLocalToWorldFrustumTransformMatrix();
			const LocalToWorldTransform = PopMath.CreateIdentityMatrix();
			const WorldToLocalTransform = PopMath.MatrixInverse4x4(LocalToWorldTransform);
			Uniforms.LocalToWorldTransform = LocalToWorldTransform;
			Uniforms.WorldToCameraTransform = WorldToCameraMatrix;
			Uniforms.CameraProjectionTransform = CameraProjectionMatrix;
			Commands.push(['Draw',Geometry,Shader,Uniforms]);
		}
		*/
		for ( let Actor of this.Actors )
		{
			const Camera = this.Camera;
			const Geometry = Assets[Actor.Geometry];
			const Shader = Assets.Shader;
			
			if ( !Geometry || !Shader )
				continue;
			
			const Uniforms = Object.assign({},Actor.Uniforms);
			const PopMath = Pop.Math;
			const RenderViewport = ScreenViewport;
			const WorldToCameraMatrix = Camera.GetWorldToCameraMatrix();
			const CameraProjectionMatrix = Camera.GetProjectionMatrix( RenderViewport );
			const ScreenToCameraTransform = PopMath.MatrixInverse4x4( CameraProjectionMatrix );
			const CameraToWorldTransform = PopMath.MatrixInverse4x4( WorldToCameraMatrix );
			//const LocalToWorldTransform = Camera.GetLocalToWorldFrustumTransformMatrix();
			const LocalToWorldTransform = PopMath.CreateIdentityMatrix();
			const WorldToLocalTransform = PopMath.MatrixInverse4x4(LocalToWorldTransform);
			Uniforms.LocalToWorldTransform = LocalToWorldTransform;
			Uniforms.WorldToCameraTransform = WorldToCameraMatrix;
			Uniforms.CameraProjectionTransform = CameraProjectionMatrix;
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
