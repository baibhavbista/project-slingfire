import Phaser from 'phaser';
import { BasePlayer } from './BasePlayer';
import { GAME_CONFIG, Team } from '../config/GameConfig';
import { INPUT_CONFIG } from '../config/InputConfig';
import { MovementSystem, MovementInput, MovementState } from '../systems/MovementSystem';
import { PlayerBulletInterface } from './PlayerBulletInterface';
import { AnimationState } from '../systems/AnimationSystem';
import { GameScene } from '../GameScene';

/**
 * Local player class that handles input and uses MovementSystem
 * Extends BasePlayer with input handling
 */
export class LocalPlayer extends BasePlayer {
  // Input
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private jumpKey!: Phaser.Input.Keyboard.Key;
  private dashKey!: Phaser.Input.Keyboard.Key;
  private shootKey!: Phaser.Input.Keyboard.Key;
  private shootKeyAlt!: Phaser.Input.Keyboard.Key;
  
  // Movement system
  private movementSystem: MovementSystem;
  private movementState: MovementState;
  private dashState: ReturnType<typeof MovementSystem.createDashState>;
  
  // Dash buffering
  private dashBuffering: boolean = false;
  private dashBufferTime: number = 0;
  
  // Dash direction buffering
  private dashDirectionBuffering: boolean = false;
  private dashDirectionBufferTime: number = 0;
  private dashDirectionInputDetected: boolean = false;
  private dashDirectionInputTime: number = 0;
  
  // Events
  public events: Phaser.Events.EventEmitter;
  
  // Shooting cooldown
  private lastShootTime: number = 0;
  
  constructor(
    scene: Phaser.Scene, 
    id: string,
    x: number, 
    y: number, 
    team: Team,
    playerName: string = 'You'
  ) {
    super(scene, id, x, y, team, playerName, true);
    
    // Enable collision and gravity for local player
    this.setCollideWorldBounds(true);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setGravityY(0); // MovementSystem will manage gravity
    
    // Initialize movement system
    this.movementSystem = new MovementSystem(scene);
    this.movementState = MovementSystem.createMovementState();
    this.dashState = MovementSystem.createDashState();
    
    // Set initial grounded state
    this.movementState.isGrounded = true;
    
    // Create event emitter for communicating with GameScene
    this.events = new Phaser.Events.EventEmitter();
    
    // Set up input
    this.setupInput();
  }
  
  /**
   * Override landing animation event to emit event
   */
  protected onLandingSquash(): void {
    this.events.emit('land');
  }
  
  private setupInput(): void {
    this.cursors = this.scene.input.keyboard!.createCursorKeys();
    this.jumpKey = this.scene.input.keyboard!.addKey(INPUT_CONFIG.ACTIONS.JUMP);
    this.dashKey = this.scene.input.keyboard!.addKey(INPUT_CONFIG.ACTIONS.DASH);
    this.shootKey = this.scene.input.keyboard!.addKey(INPUT_CONFIG.ACTIONS.SHOOT_PRIMARY);
    this.shootKeyAlt = this.scene.input.keyboard!.addKey(INPUT_CONFIG.ACTIONS.SHOOT_SECONDARY);
  }
  
  update(time: number, delta: number): void {
    // Skip if dead
    if (this.isDead) return;
    
    // Skip input processing if menu is open
    const gameScene = this.scene as GameScene;
    const isMenuOpen = gameScene && gameScene.isInGameMenuOpen ? gameScene.isInGameMenuOpen() : false;
    
    const body = this.body as Phaser.Physics.Arcade.Body;
    
    // Gather input (block all inputs if menu is open)
    const input: MovementInput = {
      left: isMenuOpen ? false : this.cursors.left.isDown,
      right: isMenuOpen ? false : this.cursors.right.isDown,
      up: isMenuOpen ? false : this.cursors.up.isDown,
      down: isMenuOpen ? false : this.cursors.down.isDown,
      jump: isMenuOpen ? false : this.jumpKey.isDown,
      dash: isMenuOpen ? false : this.dashKey.isDown
    };
    
    // Handle jump with anticipation animation
    const canJump = this.movementState.isGrounded || this.movementState.coyoteTime > 0;
    
    if (input.jump && !this.movementState.wasJumpPressed && canJump) {
      // Trigger the new animation, which handles the physics itself
      this.animationController.getAnimationSystem().createAnticipatedJump(
        this, 
        body, 
        this.animationController.getState(), 
        () => {
          this.events.emit('jump');
        }
      );
      
      // Prevent the MovementSystem from processing the jump
      this.movementState.coyoteTime = 0;
      this.movementState.isJumping = true;
      this.movementState.wasJumpPressed = true; // Prevent double-jumping
    }
    
    // Update movement through system
    this.movementSystem.updateMovement(body, input, this.movementState, delta);
    
    // Handle dash buffering and execution
    this.handleDashBuffering(body, input, delta);
    
    // Update ongoing dash
    this.movementSystem.updateDash(body, input, this.movementState, this.dashState);
    
    // Handle shooting
    this.handleShooting();
    
    // Detect state changes for events
    this.detectStateChanges();
    
    // Update facing direction
    if (this.movementState.facingDirection !== 0) {
      this.setFlipX(this.movementState.facingDirection < 0);
    }
    
    // Update crouch visual
    if (this.movementState.isCrouching !== this.movementState.wasCrouching) {
      this.setCrouching(this.movementState.isCrouching);
    }
    
    // Update animations through AnimationController
    this.animationController.update(
      body.velocity.x,
      body.velocity.y,
      this.movementState.isGrounded,
      this.movementState.isDashing,  // Use MovementState's isDashing instead
      delta,
      this.movementState.isCrouching
    );
    
    // Create dash trails while dashing
    if (this.movementState.isDashing && Math.random() < 0.8) {
      this.createDashTrail();
    }
    
    // Emit position update for networking
    this.events.emit('position-update', {
      x: this.x,
      y: this.y,
      velocityX: body.velocity.x,
      velocityY: body.velocity.y,
      flipX: this.flipX
    });
    
    // Update dash button state for edge detection (must be after dash handling)
    this.movementState.wasDashPressed = input.dash;
  }
  
  private handleDashBuffering(body: Phaser.Physics.Arcade.Body, input: MovementInput, delta: number): void {
    // Handle dash direction buffering (wait for directional input after S is pressed)
    // Only start on rising edge of dash key (key press, not hold)
    if (input.dash && !this.movementState.wasDashPressed && !this.dashDirectionBuffering && !this.movementState.isDashing && this.movementState.canDash) {
      // Start direction buffer when dash is pressed and we can dash
      this.dashDirectionBuffering = true;
      this.dashDirectionBufferTime = 0;
      this.dashDirectionInputDetected = false;
      this.dashDirectionInputTime = 0;
      // Don't update wasDashPressed here - let MovementSystem handle it
      return; // Don't execute dash immediately
    }
    
    // Update direction buffer timer
    if (this.dashDirectionBuffering) {
      this.dashDirectionBufferTime += delta;
      
      // Check if we have directional input
      const hasDirectionalInput = input.left || input.right || input.up || input.down;
      
      // If we detect first directional input, start a small additional buffer
      if (hasDirectionalInput && !this.dashDirectionInputDetected) {
        this.dashDirectionInputDetected = true;
        this.dashDirectionInputTime = 0;
      }
      
      // Update input detection timer
      if (this.dashDirectionInputDetected) {
        this.dashDirectionInputTime += delta;
      }
      
      // Execute dash if:
      // 1. We have directional input AND additional input buffer has expired
      // 2. OR main buffer has expired
      // 3. OR dash key is released with directional input
      const inputBufferExpired = this.dashDirectionInputDetected && this.dashDirectionInputTime >= GAME_CONFIG.PLAYER.DASH.DIAGONAL_WINDOW_MS;
      const mainBufferExpired = this.dashDirectionBufferTime >= GAME_CONFIG.PLAYER.DASH.DIRECTION_BUFFER_MS;
      const dashReleased = !input.dash && hasDirectionalInput;
      
      if (inputBufferExpired || mainBufferExpired || dashReleased) {
        // Execute dash with current input
        if (this.movementSystem.startDash(body, input, this.movementState, this.dashState)) {
          this.events.emit('dash-start');
        }
        this.dashDirectionBuffering = false;
        this.dashDirectionInputDetected = false;
      }
      
      // Cancel if dash key is released without direction
      if (!input.dash && !hasDirectionalInput) {
        this.dashDirectionBuffering = false;
        this.dashDirectionInputDetected = false;
      }
      
      return; // Don't process other dash logic while buffering
    }
    
    // Original dash execution buffering (for when we can't dash yet)
    // Also needs edge detection
    if (input.dash && !this.movementState.wasDashPressed && !this.dashBuffering && !this.movementState.canDash) {
      this.dashBuffering = true;
      this.dashBufferTime = 0;
    }
    
    // Update buffer timer
    if (this.dashBuffering) {
      this.dashBufferTime += delta;
      
      // Cancel buffer after window expires
      if (this.dashBufferTime > GAME_CONFIG.PLAYER.DASH.BUFFER_WINDOW_MS) {
        this.dashBuffering = false;
      }
      
      // Execute buffered dash when possible
      if (this.movementState.canDash) {
        // Use direction buffering for buffered dashes too
        this.dashBuffering = false;
        this.dashDirectionBuffering = true;
        this.dashDirectionBufferTime = 0;
        this.dashDirectionInputDetected = false;
        this.dashDirectionInputTime = 0;
      }
    }
  }
  
  private detectStateChanges(): void {
    // Jump events are now handled in the animation callback
    // Remove the old jump detection here to avoid double emission
    
    // Landing detection
    if (!this.wasGrounded && this.movementState.isGrounded) {
      this.wasGrounded = true;
      // AnimationController will handle the landing animation
    } else if (this.wasGrounded && !this.movementState.isGrounded) {
      this.wasGrounded = false;
    }
    
    // Dash end detection - use MovementState's isDashing
    if (this.wasDashing && !this.movementState.isDashing) {
      this.events.emit('dash-end');
      this.wasDashing = false;
      this._isDashing = false; // Sync local flag
    } else if (!this.wasDashing && this.movementState.isDashing) {
      this.wasDashing = true;
      this._isDashing = true; // Sync local flag
    }
  }
  
  private handleShooting(): void {
    // Can't shoot while crouching or when menu is open
    const gameScene = this.scene as GameScene;
    if (this.movementState.isCrouching || (gameScene && gameScene.isInGameMenuOpen && gameScene.isInGameMenuOpen())) {
      return;
    }
    
    if (this.shootKey.isDown || this.shootKeyAlt.isDown) {
      const now = this.scene.time.now;
      if (now - this.lastShootTime >= GAME_CONFIG.WEAPON.FIRE_RATE) {
        this.lastShootTime = now;
        const direction = this.flipX ? -1 : 1;
        const bulletData = PlayerBulletInterface.getBulletSpawnData(
          this.x,
          this.y,
          direction,
          this.team as Team
        );
        // Add team to the emitted data
        this.events.emit('shoot', {
          ...bulletData,
          direction,
          team: this.team
        });
      }
    }
  }
  
  /**
   * Set position (used for respawning)
   */
  public setPosition(x?: number, y?: number, z?: number, w?: number): this {
    super.setPosition(x, y, z, w);
    
    // Reset movement state when respawning
    this.movementState = MovementSystem.createMovementState();
    this.dashState = MovementSystem.createDashState();
    this._isDashing = false;
    this.wasDashing = false;
    this.dashBuffering = false;
    this.wasGrounded = true;
    this.lastShootTime = 0;
    
    // Clear any animations (only if controller exists - may be called during construction)
    if (this.animationController) {
      this.animationController.clearDashTrails();
    }
    
    return this;
  }
  
  /**
   * Get current movement state (for debugging)
   */
  public getMovementState(): MovementState {
    return this.movementState;
  }
  
  /**
   * Override isDashing to use MovementState
   */
  public get isDashing(): boolean {
    return this.movementState.isDashing;
  }
  
  /**
   * Get animation state for debugging
   */
  public getAnimationState(): AnimationState {
    return this.animationController.getState();
  }
  
  /**
   * Clean up resources
   */
  public destroy(fromScene?: boolean): void {
    // Remove all event emitters
    this.events.removeAllListeners();
    
    // Clean up input references
    this.cursors = null!;
    this.jumpKey = null!;
    this.dashKey = null!;
    this.shootKey = null!;
    this.shootKeyAlt = null!;
    
    // Call parent destroy
    super.destroy(fromScene);
  }
} 