import Phaser from 'phaser';
import { NetworkManager, PlayerData, BulletData } from '../network/NetworkManager';
import { RemotePlayer } from '../network/RemotePlayer';
import { LocalPlayer } from '../entities/LocalPlayer';
import { PlayerTextureManager } from '../entities/PlayerTextureManager';
import { COLORS } from '../config/Colors';
import { getSpawnPosition } from '../config/GameConfig';
import { GameHUD } from '../ui/GameHUD';
import { KillFeed } from '../ui/KillFeed';
import { EffectsSystem } from './EffectsSystem';
import { SoundManager } from '../SoundManager';
import { SHARED_CONFIG } from '../../shared/GameConstants';
import { GameScene } from '../GameScene';
import { Bullet } from '../BulletPool';

/**
 * MultiplayerCoordinator - Manages all multiplayer functionality
 * 
 * Handles:
 * - Network event handlers
 * - Player spawning/despawning
 * - Team assignment
 * - Score tracking
 * - Server reconciliation
 * - Network quality visualization
 */
export class MultiplayerCoordinator {
  private scene: GameScene;
  private networkManager: NetworkManager;
  private player: LocalPlayer;
  private remotePlayers: Map<string, RemotePlayer>;
  private gameHUD: GameHUD;
  private killFeed: KillFeed;
  private effectsSystem: EffectsSystem;
  private soundManager: SoundManager;
  
  // Track active bullets for cleanup
  private activeBullets: Map<string, { sprite: Phaser.GameObjects.GameObject, tween?: Phaser.Tweens.Tween }> = new Map();
  
  // Network quality visualization
  private networkQualityIndicators: Map<string, Phaser.GameObjects.Graphics> = new Map();
  private showNetworkQuality: boolean = false;
  
  // Client-side prediction
  private lastServerPosition: { x: number; y: number } = { x: 0, y: 0 };
  private predictionError: { x: number; y: number } = { x: 0, y: 0 };
  private reconciliationSpeed: number = 0.3;
  
  // Game state
  private localPlayerId?: string;
  private currentHealth: number = 100;
  private isDead: boolean = false;
  
  // Callbacks
  private onScoreUpdate?: (redScore: number, blueScore: number) => void;
  private onHealthUpdate?: (health: number) => void;
  private onDeathStateChange?: (isDead: boolean) => void;

  constructor(
    scene: Phaser.Scene,
    networkManager: NetworkManager,
    player: LocalPlayer,
    remotePlayers: Map<string, RemotePlayer>,
    gameHUD: GameHUD,
    killFeed: KillFeed,
    effectsSystem: EffectsSystem,
    soundManager: SoundManager
  ) {
    this.scene = scene as GameScene;
    this.networkManager = networkManager;
    this.player = player;
    this.remotePlayers = remotePlayers;
    this.gameHUD = gameHUD;
    this.killFeed = killFeed;
    this.effectsSystem = effectsSystem;
    this.soundManager = soundManager;
  }

  /**
   * Sets up all multiplayer event handlers
   */
  setupEventHandlers(): void {
    console.log("Setting up multiplayer handlers...");
    console.log("Current remotePlayers count:", this.remotePlayers.size);
    
    // Team assignment
    this.networkManager.on("team-assigned", (data: { playerId: string; team: "red" | "blue"; roomId: string }) => {
      this.localPlayerId = data.playerId;
      
      console.log(`Team assignment received: ${data.team} (was: ${this.player.team})`);
      
      // Update player team
      this.player.team = data.team;
      
      // Get the team texture using centralized manager
      const textureKey = PlayerTextureManager.getPlayerTexture(this.scene, data.team);
      
      // Force texture update
      this.player.setTexture(textureKey);
      this.player.setFrame(0);
      
      console.log(`Texture updated to: ${textureKey}`);
      
      // Teleport to team spawn point
      const spawnPos = getSpawnPosition(data.team);
      this.player.setPosition(spawnPos.x, spawnPos.y);
      
      console.log(`Joined team ${data.team} with player ID ${data.playerId}!`);
      console.log(`Connected to room ${data.roomId}`);
      
      // Update the UI with the correct team
      this.updateTeamUI(data.team);
      
      // Process any players that were added before we got our ID
      this.networkManager?.emit("process-pending-players");
    });
    
    // Player added to game
    this.networkManager.on("player-added", (player: PlayerData) => {
      // Store the player data if we don't have our ID yet
      if (!this.localPlayerId) {
        console.log(`Received player ${player.id} before getting local ID, might be us`);
        // Don't create any players until we know who we are
        return;
      }
      
      // Skip if it's the local player or already exists
      if (player.id === this.localPlayerId || this.remotePlayers.has(player.id)) {
        console.log(`Skipping player ${player.id} - is local: ${player.id === this.localPlayerId}, already exists: ${this.remotePlayers.has(player.id)}`);
        return;
      }
      
      // Create remote player
      const remotePlayer = new RemotePlayer(this.scene, player.id, player.x, player.y, player.team, player.name);
      this.remotePlayers.set(player.id, remotePlayer);
      console.log(`Player ${player.name} (${player.id}) joined on team ${player.team} at position (${player.x}, ${player.y})`);
      
      // Create network quality indicator for this player
      const indicator = this.scene.add.graphics();
      indicator.setVisible(this.showNetworkQuality);
      this.networkQualityIndicators.set(player.id, indicator);
    });
    
    // Player left
    this.networkManager.on("player-removed", (playerId: string) => {
      const remotePlayer = this.remotePlayers.get(playerId);
      if (remotePlayer) {
        console.log(`Removing player ${playerId}`);
        remotePlayer.destroy();
        this.remotePlayers.delete(playerId);
        console.log(`Player ${playerId} removed successfully`);
        
        // Remove network quality indicator
        const indicator = this.networkQualityIndicators.get(playerId);
        if (indicator) {
          indicator.destroy();
          this.networkQualityIndicators.delete(playerId);
        }
      }
    });
    
    // Player position update
    this.networkManager.on("player-updated", (player: PlayerData) => {
      const remotePlayer = this.remotePlayers.get(player.id);
      if (remotePlayer) {
        remotePlayer.updateFromServer(
          player.x, 
          player.y, 
          player.velocityX, 
          player.velocityY, 
          player.health, 
          player.flipX, 
          player.isDashing,
          player.isDead
        );
      } else if (player.id !== this.localPlayerId && !this.remotePlayers.has(player.id)) {
        // Player doesn't exist yet, create them
        console.log(`Creating player ${player.id} from update event`);
        const newRemotePlayer = new RemotePlayer(this.scene, player.id, player.x, player.y, player.team, player.name);
        this.remotePlayers.set(player.id, newRemotePlayer);
      }
    });
    
    // Bullet fired by other player
    this.networkManager.on("bullet-added", (bullet: BulletData) => {
      // Only render bullets from other players
      if (bullet.ownerId !== this.localPlayerId) {
        // Find the owner of the bullet to get their team color
        const owner = this.remotePlayers.get(bullet.ownerId);
        
        // Default to red if owner not found (should not happen)
        const teamColor = owner ? owner.team : 'red';
        const bulletColor = teamColor === "blue" ? COLORS.TEAMS.BLUE.GLOW : COLORS.TEAMS.RED.GLOW;

        // Create visual bullet with the correct team color
        const bulletSprite = this.scene.add.rectangle(
          bullet.x, 
          bullet.y, 
          SHARED_CONFIG.BULLET.WIDTH, 
          SHARED_CONFIG.BULLET.HEIGHT, 
          bulletColor
        );
        
        // Animate bullet
        const tween = this.scene.tweens.add({
          targets: bulletSprite,
          x: bullet.x + (bullet.velocityX * (SHARED_CONFIG.BULLET.LIFETIME_MS / 1000)), // Convert ms to seconds
          duration: SHARED_CONFIG.BULLET.LIFETIME_MS,
          onComplete: () => {
            bulletSprite.destroy();
            this.activeBullets.delete(bullet.id);
          }
        });
        
        // Track the bullet
        this.activeBullets.set(bullet.id, { sprite: bulletSprite, tween });
      }
    });
    
    // Bullet removed by server (collision or timeout)
    this.networkManager.on("bullet-removed", (bullet: BulletData) => {
      console.log("bullet-removed", bullet);
      // Check if we're tracking this bullet
      const trackedBullet = this.activeBullets.get(bullet.id);
      if (trackedBullet) {
        // Stop the tween if it exists
        if (trackedBullet.tween) {
          trackedBullet.tween.stop();
        }
        
        // Create impact effect at current position
        if (trackedBullet.sprite && 'x' in trackedBullet.sprite && 'y' in trackedBullet.sprite) {
          this.effectsSystem.createBulletImpactEffect(
            trackedBullet.sprite.x as number, 
            trackedBullet.sprite.y as number
          );
        }
        
        // Destroy the sprite
        trackedBullet.sprite.destroy();
        
        // Remove from tracking
        this.activeBullets.delete(bullet.id);
      }
      
      // If it's our own bullet, check if it's in the bullet pool
      if (bullet.ownerId === this.localPlayerId) {
        // Find and deactivate the bullet in our pool
        const gameScene = this.scene as GameScene;
        const bullets = gameScene.getWeaponSystem().getBulletPool().getBullets();
        // We need to match by position since we don't track bullet IDs in the pool
        const localBullet = bullets.find((b: Bullet) => 
          b.isActive && 
          Math.abs(b.x - bullet.x) < 50 // Within reasonable distance
        );
        
        if (localBullet) {
          // Create impact effect
          this.effectsSystem.createBulletImpactEffect(localBullet.x, localBullet.y);
          // Deactivate the bullet
          gameScene.getWeaponSystem().getBulletPool().deactivateBullet(localBullet);
        }
      }
    });
    
    // Game state changes
    this.networkManager.on("state-changed", (state: { gameState: string; winningTeam?: string; scores?: { red: number; blue: number } }) => {
      // Update game state UI if needed
      if (state.gameState === "ended") {
        console.log(`Game ended! ${state.winningTeam} team wins!`);
      }
      
      // Update scores
      if (state.scores) {
        this.gameHUD.updateScores(state.scores.red, state.scores.blue);
        this.onScoreUpdate?.(state.scores.red, state.scores.blue);
      }
    });
    
    // Kill events
    this.networkManager.on("player-killed", (data: { killerId: string; victimId: string; killerName?: string; victimName?: string }) => {
      // Add to kill feed
      const killerName = data.killerName || "Player";
      const victimName = data.victimName || "Player";
      this.killFeed.addKillMessage(killerName, victimName);
      
      // Play death sound if it's the local player
      if (data.victimId === this.localPlayerId) {
        // Could add death sound here
      }
    });
    
    // Local player server updates (for reconciliation)
    this.networkManager.on("local-player-server-update", (serverData: { x: number; y: number; health: number; isDead?: boolean; respawnTimer?: number }) => {
      this.handleServerReconciliation({ x: serverData.x, y: serverData.y });
      
      // Update health and check for damage
      if (serverData.health !== undefined) {
        const previousHealth = this.player.getHealth();
        this.player.updateHealth(serverData.health);
        this.gameHUD.updateHealth(serverData.health);
        this.onHealthUpdate?.(serverData.health);
        
        // Trigger hit effect if we took damage
        if (previousHealth > serverData.health && serverData.health > 0) {
          this.effectsSystem.createHitEffect(this.player.x, this.player.y);
          this.soundManager.playHit();
        }
      }
      
      // Update death state
      if (serverData.isDead !== undefined) {
        const wasDead = !this.player.visible; // Using visibility as proxy for death state
        this.player.setDead(serverData.isDead);
        
        if (serverData.isDead && !wasDead) {
          // Player just died
          this.player.setAlpha(0.3);
          this.player.setVelocity(0, 0);
          const team = this.networkManager?.getPlayerTeam() || "red";
          this.effectsSystem.createDeathEffect(this.player.x, this.player.y, team);
          this.soundManager.playDeath();
          this.onDeathStateChange?.(true);
        } else if (!serverData.isDead && wasDead) {
          // Player respawned
          this.player.setAlpha(1);
          this.gameHUD.setRespawnTimer(0);
          this.onDeathStateChange?.(false);
        }
      }
      
      // Update respawn timer
      if (serverData.isDead && serverData.respawnTimer !== undefined) {
        const seconds = Math.ceil(serverData.respawnTimer / 1000);
        this.gameHUD.setRespawnTimer(seconds);
      }
    });
    
    console.log("Multiplayer handlers ready!");
  }

  /**
   * Initializes the coordinator and sets up initial state
   */
  initialize(): void {
    // If we already have player ID, set it
    const playerId = this.networkManager.getPlayerId();
    if (playerId) {
      this.localPlayerId = playerId;
      console.log("Already have player ID:", this.localPlayerId);
    }
    
    // Set initial team color
    const team = this.networkManager.getPlayerTeam();
    if (team) {
      console.log("Already assigned to team:", team);
      
      // Update the player's team and texture
      this.player.team = team;
      
      // Get the team texture using centralized manager
      const textureKey = PlayerTextureManager.getPlayerTexture(this.scene, team);
      
      // Force texture update
      this.player.setTexture(textureKey);
      console.log(`Updated texture to ${textureKey} for already assigned team ${team}`);
      
      // Teleport to team spawn point if already assigned
      const spawnPos = getSpawnPosition(team);
      this.player.setPosition(spawnPos.x, spawnPos.y);
    }
    
    // Setup UI
    this.setupMultiplayerUI();
    
    // Request current room state to ensure we have all players
    console.log("Local player ID:", this.localPlayerId);
    console.log("Checking for existing players in room...");
  }

  /**
   * Sets up multiplayer-specific UI
   */
  private setupMultiplayerUI(): void {
    // Get team
    const team = this.networkManager?.getPlayerTeam() || 'unknown';
    
    // Create multiplayer-specific UI elements
    this.gameHUD.createMultiplayerUI(team, () => this.leaveMultiplayer());
    
    // Toggle network quality visualization with F4
    this.scene.input.keyboard?.on('keydown-F4', () => {
      this.showNetworkQuality = !this.showNetworkQuality;
      this.networkQualityIndicators.forEach(indicator => {
        indicator.setVisible(this.showNetworkQuality);
      });
    });
  }

  /**
   * Updates the team UI when team is assigned
   */
  private updateTeamUI(team: 'red' | 'blue'): void {
    // Destroy existing UI
    if (this.gameHUD) {
      // We need to update the team indicator
      // For now, recreate the UI with the correct team
      this.gameHUD.createMultiplayerUI(team, () => this.leaveMultiplayer());
    }
  }

  /**
   * Handles leaving multiplayer
   */
  private leaveMultiplayer(): void {
    if (this.networkManager) {
      this.networkManager.disconnect();
    }
    
    // Clean up remote players
    this.remotePlayers.forEach(player => player.destroy());
    this.remotePlayers.clear();
    
    // Reset player to red team and texture
    this.player.team = 'red';
    const textureKey = PlayerTextureManager.getPlayerTexture(this.scene, 'red');
    this.player.setTexture(textureKey);
    
    // Clean up network quality indicators
    this.networkQualityIndicators.forEach(indicator => indicator.destroy());
    this.networkQualityIndicators.clear();
    
    // Clean up registry
    this.scene.game.registry.remove('networkManager');
    this.scene.game.registry.remove('isMultiplayer');
    
    console.log("Left multiplayer mode");
    
    // Transition back to lobby or restart
    this.scene.scene.start('LobbyScene');
  }

  /**
   * Handles server position reconciliation
   */
  handleServerReconciliation(serverPos: { x: number; y: number }): void {
    // Calculate prediction error
    const currentX = this.player.x;
    const currentY = this.player.y;
    
    this.predictionError.x = serverPos.x - currentX;
    this.predictionError.y = serverPos.y - currentY;
    
    // Only reconcile if error is significant (to avoid jitter)
    const errorMagnitude = Math.sqrt(this.predictionError.x * this.predictionError.x + this.predictionError.y * this.predictionError.y);
    
    if (errorMagnitude > 5) { // 5 pixels threshold
      // Store server position for smooth reconciliation
      this.lastServerPosition.x = serverPos.x;
      this.lastServerPosition.y = serverPos.y;
      
      // Be more tolerant during dashes and shortly after
      const snapThreshold = this.player.isDashing ? 300 : 100;
      
      // If error is too large, snap to server position
      if (errorMagnitude > snapThreshold) {
        this.player.setPosition(serverPos.x, serverPos.y);
        this.predictionError.x = 0;
        this.predictionError.y = 0;
        console.log(`Large prediction error (${errorMagnitude.toFixed(1)}px), snapping to server position`);
      }
    } else {
      // Small error, clear it
      this.predictionError.x = 0;
      this.predictionError.y = 0;
    }
  }

  /**
   * Updates network quality indicators
   */
  updateNetworkQualityIndicators(): void {
    if (!this.showNetworkQuality) return;
    
    this.remotePlayers.forEach((remotePlayer, playerId) => {
      const indicator = this.networkQualityIndicators.get(playerId);
      if (!indicator) return;
      
      // Clear previous drawing
      indicator.clear();
      
      // Get interpolation data from remote player
      // TODO: Fix getTargetX/Y methods on RemotePlayer
      const dx = 0;
      const dy = 0;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Color based on prediction accuracy
      let color = 0x00FF00; // Green - good
      if (distance > 50) {
        color = 0xFFFF00; // Yellow - medium
      }
      if (distance > 100) {
        color = 0xFF0000; // Red - poor
      }
      
      // Draw indicator
      indicator.lineStyle(2, color, 0.8);
      indicator.strokeCircle(remotePlayer.x, remotePlayer.y - 70, 5);
      
      // Draw prediction line
      indicator.lineStyle(1, color, 0.4);
      indicator.beginPath();
      indicator.moveTo(remotePlayer.x, remotePlayer.y);
      indicator.lineTo(remotePlayer.x, remotePlayer.y); // TODO: Fix when getTargetX/Y available
      indicator.strokePath();
    });
  }

  /**
   * Updates the coordinator (called from scene update)
   */
  update(delta: number): void {
    // Apply smooth reconciliation if we have prediction error
    if (this.predictionError.x !== 0 || this.predictionError.y !== 0) {
      const reconcileX = this.predictionError.x * this.reconciliationSpeed * (delta / 1000);
      const reconcileY = this.predictionError.y * this.reconciliationSpeed * (delta / 1000);
      
      // Apply reconciliation
      this.player.x += reconcileX;
      this.player.y += reconcileY;
      
      // Reduce error
      this.predictionError.x -= reconcileX;
      this.predictionError.y -= reconcileY;
      
      // Clear tiny errors
      if (Math.abs(this.predictionError.x) < 0.1) this.predictionError.x = 0;
      if (Math.abs(this.predictionError.y) < 0.1) this.predictionError.y = 0;
    }
    
    // Update network quality indicators
    this.updateNetworkQualityIndicators();
  }

  /**
   * Sets callbacks for game state updates
   */
  setCallbacks(callbacks: {
    onScoreUpdate?: (redScore: number, blueScore: number) => void;
    onHealthUpdate?: (health: number) => void;
    onDeathStateChange?: (isDead: boolean) => void;
  }): void {
    this.onScoreUpdate = callbacks.onScoreUpdate;
    this.onHealthUpdate = callbacks.onHealthUpdate;
    this.onDeathStateChange = callbacks.onDeathStateChange;
  }

  /**
   * Gets the local player ID
   */
  getLocalPlayerId(): string | undefined {
    return this.localPlayerId;
  }

  /**
   * Get current network prediction error
   */
  getPredictionError(): { x: number; y: number } {
    return this.predictionError;
  }

  /**
   * Cleans up the coordinator
   */
  destroy(): void {
    // Remove all event listeners
    this.networkManager.removeAllListeners();
    
    // Clean up indicators
    this.networkQualityIndicators.forEach(indicator => indicator.destroy());
    this.networkQualityIndicators.clear();
  }
} 